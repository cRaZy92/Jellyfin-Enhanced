using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiWatchingNowTests
{
    private static readonly Guid Caller = Guid.NewGuid();

    private static SessionInfo Session(Guid userId, string name, BaseItemDto? item, bool paused = false, string? imageTag = null)
    {
        var session = new SessionInfo(Mock.Of<ISessionManager>(), NullLogger.Instance)
        {
            UserId = userId,
            UserName = name,
            UserPrimaryImageTag = imageTag,
            NowPlayingItem = item,
            DeviceName = "secret-device",
            Client = "secret-client",
            RemoteEndPoint = "203.0.113.9",
        };
        session.PlayState = new PlayerStateInfo { IsPaused = paused, PositionTicks = 42 };
        return session;
    }

    private static BaseItemDto Dto(Guid id, BaseItemKind kind, Guid? season = null, Guid? series = null)
        => new() { Id = id, Type = kind, SeasonId = season, SeriesId = series };

    private static JellyfinEnhancedController Controller(ApiPluginFixture fixture, IEnumerable<SessionInfo> sessions, params Guid[] hiddenItems)
    {
        var user = new User("caller", "default", "default") { Id = Caller };
        var users = new Mock<IUserManager>();
        users.Setup(m => m.GetUserById(Caller)).Returns(user);
        var library = new Mock<ILibraryManager>();
        library.Setup(m => m.GetItemById<BaseItem>(It.IsAny<Guid>(), user))
            .Returns((Guid id, User? _) => hiddenItems.Contains(id) ? null : new Movie { Id = id });
        var sessionManager = new Mock<ISessionManager>();
        sessionManager.SetupGet(m => m.Sessions).Returns(sessions);
        var controller = ApiAssetTests.Controller(fixture.Core, users.Object, library.Object, sessionManager.Object);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", Caller.ToString())], "test"));
        return controller;
    }

    private static JsonElement Viewers(IActionResult result)
    {
        var ok = Assert.IsType<OkObjectResult>(result);
        return JsonSerializer.SerializeToElement(ok.Value).GetProperty("viewers");
    }

    [Fact]
    public void DisabledSettingReturns503()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.WatchingAvatarsEnabled = false;
        var result = Controller(fixture, []).GetWatchingNow();
        Assert.Equal(503, Assert.IsAssignableFrom<IStatusCodeActionResult>(result).StatusCode);
    }

    [Fact]
    public void ReturnsOnlyPermittedFieldsAndDisablesCaching()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.WatchingAvatarsEnabled = true;
        var userId = Guid.NewGuid();
        var movie = Guid.NewGuid();
        var controller = Controller(fixture, [Session(userId, "adam", Dto(movie, BaseItemKind.Movie), imageTag: "tag")]);

        var viewer = Assert.Single(Viewers(controller.GetWatchingNow()).EnumerateArray());

        Assert.Equal(
            ["hasImage", "isPaused", "itemIds", "userId", "userName"],
            viewer.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal));
        Assert.Equal(userId.ToString("N"), viewer.GetProperty("userId").GetString());
        Assert.Equal("adam", viewer.GetProperty("userName").GetString());
        Assert.True(viewer.GetProperty("hasImage").GetBoolean());
        Assert.False(viewer.GetProperty("isPaused").GetBoolean());
        Assert.Equal([movie.ToString("N")], viewer.GetProperty("itemIds").EnumerateArray().Select(i => i.GetString()));
        Assert.Equal("no-store", controller.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public void DropsInaccessibleItemsUnsupportedTypesAndIdleSessions()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.WatchingAvatarsEnabled = true;
        var hidden = Guid.NewGuid();
        var controller = Controller(fixture,
        [
            Session(Guid.NewGuid(), "hidden", Dto(hidden, BaseItemKind.Movie)),
            Session(Guid.NewGuid(), "music", Dto(Guid.NewGuid(), BaseItemKind.Audio)),
            Session(Guid.NewGuid(), "tv", Dto(Guid.NewGuid(), BaseItemKind.TvChannel)),
            Session(Guid.NewGuid(), "idle", null),
            Session(Guid.Empty, "no-user", Dto(Guid.NewGuid(), BaseItemKind.Movie)),
        ], hidden);

        Assert.Empty(Viewers(controller.GetWatchingNow()).EnumerateArray());
    }

    [Fact]
    public void EpisodeExpandsToSeasonAndSeries()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.WatchingAvatarsEnabled = true;
        Guid episode = Guid.NewGuid(), season = Guid.NewGuid(), series = Guid.NewGuid();
        var controller = Controller(fixture, [Session(Guid.NewGuid(), "lenka", Dto(episode, BaseItemKind.Episode, season, series))]);

        var viewer = Assert.Single(Viewers(controller.GetWatchingNow()).EnumerateArray());

        Assert.Equal(
            [episode.ToString("N"), season.ToString("N"), series.ToString("N")],
            viewer.GetProperty("itemIds").EnumerateArray().Select(i => i.GetString()));
    }

    [Theory]
    [InlineData(true, true, true)]
    [InlineData(true, false, false)]
    public void SameUserOnSameItemMergesAndIsPausedOnlyWhenAllSessionsAre(bool first, bool second, bool expected)
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.WatchingAvatarsEnabled = true;
        var userId = Guid.NewGuid();
        var movie = Guid.NewGuid();
        var controller = Controller(fixture,
        [
            Session(userId, "adam", Dto(movie, BaseItemKind.Movie), first),
            Session(userId, "adam", Dto(movie, BaseItemKind.Movie), second),
        ]);

        var viewer = Assert.Single(Viewers(controller.GetWatchingNow()).EnumerateArray());

        Assert.Equal(expected, viewer.GetProperty("isPaused").GetBoolean());
    }
}
