import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, englishT } from '../helpers/harness.mjs';

const MOVIE = 'a'.repeat(32);
const SERIES = 'b'.repeat(32);
const OTHER = 'c'.repeat(32);
const card = (id, attr = 'data-id') => `<div class="card" ${attr}="${id}"><div class="cardBox"><div class="cardScalable"><a class="cardImageContainer"></a><div class="cardOverlayContainer"></div></div></div></div>`;
const viewer = (name, itemIds = [MOVIE], extra = {}) => ({ userId: `${name}-id`, userName: name, hasImage: false, isPaused: false, itemIds, ...extra });
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { html = card(MOVIE), responses = [], enabled = true } = {}) {
  const timers = new Map();
  let seq = 0, hidden = false, epoch = 1, userChange = null, bodyCallback = null;
  const calls = [];
  const queue = [...responses];
  const h = createHarness({
    html,
    JE: {
      t: englishT,
      pluginConfig: { WatchingAvatarsEnabled: enabled },
      session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange: (_, fn) => { userChange = fn; } },
      core: {
        api: { plugin: async (path, options) => { calls.push({ path, options }); const next = queue.shift() ?? { viewers: [] }; if (typeof next === 'function') return next(); if (next instanceof Error) throw next; return next; } },
        dom: { onBodyMutation: (_, fn) => { bodyCallback = fn; }, removeBodySubscriber: () => { bodyCallback = null; } }
      }
    },
    globals: { setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => { timers.delete(id); } }
  });
  t.after(() => h.close());
  Object.defineProperty(h.document, 'hidden', { configurable: true, get: () => hidden });
  h.load('core/lifecycle.js');
  h.load('extras/watching-avatars.js');
  return {
    ...h, calls, timers,
    host: (root = h.document) => root.querySelector('.je-watching-avatars'),
    delays: () => [...timers.values()].map(timer => timer.ms),
    async start() { h.JE.watchingAvatars.initialize(); await settle(); },
    async tick(ms = 10000) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } await settle(); },
    async mutate() { bodyCallback?.([]); await this.tick(250); },
    setHidden(value) { hidden = value; h.document.dispatchEvent(new h.window.Event('visibilitychange')); },
    switchUser() { epoch++; userChange?.({}); }
  };
}

test('does nothing while the admin setting is off', async t => {
  const h = setup(t, { enabled: false });
  await h.start();
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
});

test('draws an avatar on the matching card only, after the hover overlay', async t => {
  const h = setup(t, { html: card(MOVIE) + card(OTHER), responses: [{ viewers: [viewer('adam')] }] });
  await h.start();
  assert.equal(h.calls[0].path, '/watching-now');
  const hosts = h.document.querySelectorAll('.je-watching-avatars');
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].closest('.card').dataset.id, MOVIE);
  assert.equal(hosts[0].previousElementSibling.className, 'cardOverlayContainer');
  assert.equal(hosts[0].querySelector('.je-watching-avatar').title, 'adam is watching');
  assert.equal(hosts[0].querySelector('.je-watching-avatar').getAttribute('aria-label'), 'adam is watching');
});

test('sits bottom-left, clear of Jellyfin\'s right-aligned card buttons, and stays hoverable on an active card', async t => {
  const h = setup(t, { html: card(MOVIE) + card(OTHER), responses: [{ viewers: [viewer('adam', [MOVIE, OTHER])] }] });
  await h.start();
  const [focused, revealed] = h.document.querySelectorAll('.card');
  const style = el => h.window.getComputedStyle(el);
  const hostStyle = style(h.host(focused));
  assert.equal(hostStyle.justifyContent, 'flex-start');
  assert.equal(hostStyle.right, 'auto');

  focused.querySelector('.cardImageContainer').setAttribute('href', '#');
  focused.querySelector('.cardImageContainer').focus();
  revealed.classList.add('je-tag-reveal');
  for (const c of [focused, revealed]) {
    assert.notEqual(style(h.host(c)).opacity, '0');
    assert.equal(style(c.querySelector('.je-watching-avatar')).pointerEvents, 'auto');
  }
});

test('matches dashed upper-case ids and data-itemid cards', async t => {
  const dashed = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
  const h = setup(t, { html: card(dashed) + card(SERIES, 'data-itemid'), responses: [{ viewers: [viewer('adam', [MOVIE, SERIES])] }] });
  await h.start();
  assert.equal(h.document.querySelectorAll('.je-watching-avatars').length, 2);
});

test('removes the avatar when playback ends', async t => {
  const h = setup(t, { responses: [{ viewers: [viewer('adam')] }, { viewers: [] }] });
  await h.start();
  assert.ok(h.host());
  await h.tick();
  assert.equal(h.host(), null);
});

test('shows three avatars and lists the rest on a +N chip', async t => {
  const names = ['ann', 'ben', 'cat', 'dan', 'eve'];
  const h = setup(t, { responses: [{ viewers: names.map(name => viewer(name)) }] });
  await h.start();
  assert.equal(h.document.querySelectorAll('.je-watching-avatar').length, 3);
  const chip = h.document.querySelector('.je-watching-more');
  assert.equal(chip.textContent, '+2');
  assert.equal(chip.title, 'dan is watching\neve is watching');
});

test('marks paused viewers and names them as paused', async t => {
  const h = setup(t, { responses: [{ viewers: [viewer('lenka', [MOVIE], { isPaused: true })] }] });
  await h.start();
  const avatar = h.document.querySelector('.je-watching-avatar');
  assert.ok(avatar.classList.contains('is-paused'));
  assert.equal(avatar.title, 'lenka paused');
});

test('uses the profile picture and falls back to the initial when it breaks', async t => {
  const h = setup(t, { responses: [{ viewers: [viewer('adam', [MOVIE], { hasImage: true })] }] });
  await h.start();
  const avatar = h.document.querySelector('.je-watching-avatar');
  const image = avatar.querySelector('img');
  assert.match(image.src, /Users\/adam-id\/Images\/Primary/);
  image.dispatchEvent(new h.window.Event('error'));
  assert.equal(avatar.querySelector('img'), null);
  assert.equal(avatar.textContent, 'A');
});

test('shows the initial for a user without a picture', async t => {
  const h = setup(t, { responses: [{ viewers: [viewer('šimon')] }] });
  await h.start();
  const avatar = h.document.querySelector('.je-watching-avatar');
  assert.equal(avatar.querySelector('img'), null);
  assert.equal(avatar.textContent, 'Š');
});

test('renders HTML in a user name as plain text', async t => {
  const name = '<img src=x onerror=alert(1)>';
  const h = setup(t, { responses: [{ viewers: [viewer(name)] }] });
  await h.start();
  const avatar = h.document.querySelector('.je-watching-avatar');
  assert.equal(avatar.querySelector('img'), null);
  assert.equal(avatar.title, `${name} is watching`);
});

test('a user on two episodes appears once on the series and is paused only if both are', async t => {
  const first = viewer('adam', ['1'.repeat(32), SERIES], { isPaused: true });
  const second = viewer('adam', ['2'.repeat(32), SERIES], { isPaused: false });
  const h = setup(t, { html: card(SERIES), responses: [{ viewers: [first, second] }] });
  await h.start();
  const avatars = h.document.querySelectorAll('.je-watching-avatar');
  assert.equal(avatars.length, 1);
  assert.equal(avatars[0].classList.contains('is-paused'), false);
});

test('clicking an avatar opens the item through the card', async t => {
  const h = setup(t, { responses: [{ viewers: [viewer('adam')] }] });
  await h.start();
  let opened = 0;
  h.document.querySelector('.cardOverlayContainer').addEventListener('click', () => opened++);
  h.document.querySelector('.je-watching-avatar').click();
  assert.equal(opened, 1);
});

test('draws on cards added after a poll and leaves unchanged cards alone', async t => {
  const h = setup(t, { html: '<div id="grid"></div>' + card(MOVIE), responses: [{ viewers: [viewer('adam')] }, { viewers: [viewer('adam')] }] });
  await h.start();
  const before = h.host().firstElementChild;
  h.document.getElementById('grid').innerHTML = card(MOVIE);
  await h.mutate();
  assert.equal(h.document.querySelectorAll('.je-watching-avatars').length, 2);
  await h.tick();
  assert.equal(before.isConnected, true);
});

test('removes avatars from a card reused for another item', async t => {
  const h = setup(t, { responses: [{ viewers: [viewer('adam')] }] });
  await h.start();
  h.document.querySelector('.card').dataset.id = OTHER;
  await h.mutate();
  assert.equal(h.host(), null);
});

test('polls every 10 seconds, pauses while hidden and polls at once when visible', async t => {
  const h = setup(t);
  await h.start();
  assert.deepEqual(h.delays(), [10000]);
  await h.tick();
  assert.equal(h.calls.length, 2);
  h.setHidden(true);
  assert.equal(h.timers.size, 0);
  h.setHidden(false);
  await settle();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.delays(), [10000]);
});

test('never runs two requests at once', async t => {
  let release;
  const h = setup(t, { responses: [() => new Promise(resolve => { release = resolve; })] });
  await h.start();
  h.setHidden(true);
  h.setHidden(false);
  await settle();
  assert.equal(h.calls.length, 1);
  release({ viewers: [] });
  await settle();
  assert.deepEqual(h.delays(), [10000]);
});

test('backs off to 60 seconds after a failure and recovers', async t => {
  const h = setup(t, { responses: [httpError(500), { viewers: [viewer('adam')] }] });
  await h.start();
  assert.deepEqual(h.delays(), [60000]);
  await h.tick(60000);
  assert.ok(h.host());
  assert.deepEqual(h.delays(), [10000]);
});

for (const status of [403, 503]) {
  test(`stops polling and clears avatars on ${status}`, async t => {
    const h = setup(t, { responses: [{ viewers: [viewer('adam')] }, httpError(status)] });
    await h.start();
    await h.tick();
    assert.equal(h.host(), null);
    assert.equal(h.timers.size, 0);
    h.setHidden(true);
    h.setHidden(false);
    await settle();
    assert.equal(h.calls.length, 2);
  });
}

test('a user switch clears avatars and discards a response still in flight', async t => {
  let release;
  const h = setup(t, { responses: [{ viewers: [viewer('adam')] }, () => new Promise(resolve => { release = resolve; })] });
  await h.start();
  await h.tick();
  h.switchUser();
  assert.equal(h.host(), null);
  release({ viewers: [viewer('adam')] });
  await settle();
  assert.equal(h.host(), null);
  assert.equal(h.timers.size, 0);
});

test('starts again when the next user has loaded', async t => {
  const h = setup(t, { responses: [{ viewers: [] }, { viewers: [viewer('lenka')] }] });
  await h.start();
  h.switchUser();
  h.document.dispatchEvent(new h.window.Event('je:user-data-loaded'));
  await settle();
  assert.ok(h.host());
});
