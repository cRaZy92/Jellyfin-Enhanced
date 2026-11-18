// /js/extras/watching-avatars.js
// Shows who is watching what right now as small avatars on posters.

(function (JE) {
    'use strict';

    const FEATURE = 'watching-avatars';
    const STYLE_ID = 'je-watching-avatars-styles';
    const HOST_CLASS = 'je-watching-avatars';
    const POLL_MS = 10000;
    const BACKOFF_MS = 60000;
    const RENDER_DEBOUNCE_MS = 250;
    const MAX_VISIBLE = 3;
    const ITEM_ID = /^[a-f0-9]{32}$/;

    let running = false;
    let inFlight = false;
    let generation = 0; // bumped on stop, so a response from before it is dropped
    let pollTimer = null;
    let renderTimer = null;
    let lifecycle = null;
    /** @type {Map<string, Array<Object>>} */
    let viewersByItem = new Map();

    // ── Data ─────────────────────────────────────────────────────────────────

    /**
     * Index viewers by item. One user on several episodes shares a season and
     * series, so they are merged there and count as paused only if all are.
     */
    function indexViewers(viewers) {
        const byItem = new Map();
        for (const viewer of viewers) {
            for (const itemId of viewer.itemIds || []) {
                if (!byItem.has(itemId)) byItem.set(itemId, new Map());
                const users = byItem.get(itemId);
                const known = users.get(viewer.userId);
                users.set(viewer.userId, known
                    ? { ...known, isPaused: known.isPaused && viewer.isPaused }
                    : viewer);
            }
        }
        const sorted = new Map();
        for (const [itemId, users] of byItem) {
            sorted.set(itemId, [...users.values()].sort((a, b) =>
                Number(a.isPaused) - Number(b.isPaused)
                || String(a.userName).localeCompare(String(b.userName))));
        }
        return sorted;
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    const labelFor = (viewer) => JE.t(
        viewer.isPaused ? 'watching_avatars_paused' : 'watching_avatars_watching',
        { name: viewer.userName });

    const initialOf = (name) => (Array.from(String(name || '').trim())[0] || '?').toLocaleUpperCase();

    /** A stable hue per user, so a user without a picture keeps one colour. */
    function hueOf(userId) {
        let hash = 0;
        for (const char of String(userId)) hash = (hash * 31 + char.charCodeAt(0)) % 360;
        return hash;
    }

    function showInitial(avatar, viewer) {
        avatar.textContent = initialOf(viewer.userName);
        avatar.style.backgroundColor = `hsl(${hueOf(viewer.userId)} 50% 38%)`;
    }

    function buildAvatar(viewer) {
        const avatar = document.createElement('span');
        const label = labelFor(viewer);
        avatar.className = `je-watching-avatar${viewer.isPaused ? ' is-paused' : ''}`;
        avatar.title = label;
        avatar.setAttribute('role', 'img');
        avatar.setAttribute('aria-label', label);
        if (!viewer.hasImage) {
            showInitial(avatar, viewer);
            return avatar;
        }
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('error', () => {
            image.remove();
            showInitial(avatar, viewer);
        }, { once: true });
        image.src = `${ApiClient.getUrl(`Users/${encodeURIComponent(viewer.userId)}/Images/Primary`)}?height=56&quality=80`;
        avatar.appendChild(image);
        return avatar;
    }

    function buildMoreChip(hidden) {
        const chip = document.createElement('span');
        const labels = hidden.map(labelFor);
        chip.className = 'je-watching-more';
        chip.textContent = `+${hidden.length}`;
        chip.title = labels.join('\n');
        chip.setAttribute('role', 'img');
        chip.setAttribute('aria-label', labels.join(', '));
        return chip;
    }

    /** The host sits outside Jellyfin's clickable card parts, so pass clicks on to them. */
    function openCard(event) {
        event.preventDefault();
        event.stopPropagation();
        const scalable = event.currentTarget.parentElement;
        const target = scalable?.querySelector('.cardOverlayContainer') || scalable?.querySelector('.cardImageContainer');
        target?.click();
    }

    function cardItemId(scalable) {
        const holder = scalable.closest('[data-id]') || scalable.closest('[data-itemid]');
        const raw = holder?.getAttribute('data-id') || holder?.getAttribute('data-itemid') || '';
        const itemId = raw.replace(/-/g, '').toLowerCase();
        return ITEM_ID.test(itemId) ? itemId : '';
    }

    function renderCard(scalable) {
        const viewers = viewersByItem.get(cardItemId(scalable));
        let host = scalable.querySelector(`:scope > .${HOST_CLASS}`);
        if (!viewers) {
            host?.remove();
            return;
        }
        // Unchanged cards are not written to, so this module's own DOM writes
        // cannot keep the shared body observer busy.
        const signature = JSON.stringify(viewers.map(v => [v.userId, v.userName, v.hasImage, v.isPaused]));
        if (host?.dataset.jeSignature === signature) return;
        if (!host) {
            host = document.createElement('div');
            host.className = HOST_CLASS;
            host.addEventListener('click', openCard);
            scalable.appendChild(host);
        }
        host.dataset.jeSignature = signature;
        const parts = viewers.slice(0, MAX_VISIBLE).map(buildAvatar);
        if (viewers.length > MAX_VISIBLE) parts.push(buildMoreChip(viewers.slice(MAX_VISIBLE)));
        host.replaceChildren(...parts);
    }

    function clearAvatars() {
        document.querySelectorAll(`.${HOST_CLASS}`).forEach(host => host.remove());
    }

    function render() {
        if (!viewersByItem.size) {
            clearAvatars();
            return;
        }
        document.querySelectorAll('.cardScalable').forEach(renderCard);
    }

    function scheduleRender() {
        if (!viewersByItem.size || renderTimer !== null) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            render();
        }, RENDER_DEBOUNCE_MS);
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${HOST_CLASS} {
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0.6em;
                z-index: 4;
                display: flex;
                justify-content: center;
                pointer-events: none;
            }
            .je-watching-avatar, .je-watching-more {
                box-sizing: border-box;
                flex: 0 0 auto;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: clamp(20px, 17%, 30px);
                aspect-ratio: 1;
                overflow: hidden;
                border: 2px solid rgba(0, 0, 0, 0.75);
                border-radius: 50%;
                background-color: #30363d;
                color: #fff;
                font-size: 11px;
                font-weight: 600;
                line-height: 1;
                cursor: pointer;
                pointer-events: auto;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
            }
            .je-watching-avatar + .je-watching-avatar,
            .je-watching-avatar + .je-watching-more { margin-inline-start: -6px; }
            .je-watching-avatar img { width: 100%; height: 100%; object-fit: cover; }
            .je-watching-avatar.is-paused { filter: grayscale(0.7) brightness(0.65); }
        `;
        document.head.appendChild(style);
    }

    // ── Polling ──────────────────────────────────────────────────────────────

    function schedulePoll(delay) {
        clearTimeout(pollTimer);
        pollTimer = null;
        if (running && !document.hidden) pollTimer = setTimeout(poll, delay);
    }

    async function poll() {
        if (!running || inFlight || document.hidden) return;
        inFlight = true;
        const started = generation;
        const epoch = JE.session?.getEpoch?.();
        const isStale = () => started !== generation
            || (epoch !== undefined && JE.session?.isCurrent?.(epoch) === false);
        let delay = POLL_MS;
        try {
            const data = await JE.core.api.plugin('/watching-now', { skipCache: true, skipRetry: true, priority: 'low' });
            if (isStale()) return;
            viewersByItem = indexViewers(Array.isArray(data?.viewers) ? data.viewers : []);
            render();
        } catch (err) {
            if (isStale()) return;
            if (err?.status === 403 || err?.status === 503) {
                stop();
                return;
            }
            delay = BACKOFF_MS;
        } finally {
            if (started === generation) inFlight = false;
        }
        if (!isStale()) schedulePoll(delay);
    }

    function onVisibilityChange() {
        if (document.hidden) {
            clearTimeout(pollTimer);
            pollTimer = null;
        } else {
            poll();
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    function stop() {
        generation++;
        running = false;
        inFlight = false;
        clearTimeout(pollTimer);
        clearTimeout(renderTimer);
        pollTimer = null;
        renderTimer = null;
        viewersByItem = new Map();
        if (lifecycle) {
            lifecycle.teardown();
            lifecycle = null;
        }
        clearAvatars();
        document.getElementById(STYLE_ID)?.remove();
    }

    function start() {
        if (running || !JE.pluginConfig?.WatchingAvatarsEnabled) return;
        running = true;
        injectStyles();
        lifecycle = JE.core.lifecycle.register(FEATURE);
        document.addEventListener('visibilitychange', onVisibilityChange);
        lifecycle.track({ el: document, type: 'visibilitychange', fn: onVisibilityChange });
        JE.core.dom.onBodyMutation(FEATURE, scheduleRender);
        lifecycle.track(() => JE.core.dom.removeBodySubscriber(FEATURE));
        poll();
    }

    JE.watchingAvatars = { initialize: start, destroy: stop };

    // Avatars belong to the signed-in user's view of the server.
    JE.session?.onUserChange(FEATURE, stop);
    document.addEventListener('je:user-data-loaded', start);

})(window.JellyfinEnhanced);
