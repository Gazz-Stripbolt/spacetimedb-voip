// Demo: voice rooms plus a proximity "campfire" where you walk around a 2D map.
// Serves the web client at /route/. The C# twin of demo/rust.

using SpacetimeDB;

public static partial class Module
{
    /// <summary>The campfire map is 0..Map x 0..Map.</summary>
    const float Map = 100f;

    [SpacetimeDB.Table(Accessor = "DemoPlayer", Public = true)]
    public partial struct DemoPlayer
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public string Name;
        public float X;
        public float Y;
    }

    [SpacetimeDB.Reducer(ReducerKind.Init)]
    public static void Init(ReducerContext ctx)
    {
        VoipConfigure(ctx, VoipSettings.Default);
        VoipNewRoom(ctx, "Lobby", new VoipRoomOptions());
        VoipNewRoom(ctx, "Campfire", new VoipRoomOptions(Spatial: true, Range: 30f));
        // Locked: only module code can put people here (see VoipJoinRoom). The demo never does.
        VoipNewRoom(ctx, "Staff", new VoipRoomOptions(Locked: true));
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientConnected)]
    public static void Connected(ReducerContext ctx)
    {
        VoipOnConnect(ctx);
        if (ctx.Db.DemoPlayer.Identity.Find(ctx.Sender) is null)
        {
            var hex = ctx.Sender.ToString();
            var tail = hex[^4..];
            // Spread newcomers around the middle of the map, deterministically.
            var seed = Convert.ToUInt32(tail, 16);
            ctx.Db.DemoPlayer.Insert(new DemoPlayer
            {
                Identity = ctx.Sender,
                Name = $"guest-{tail}",
                X = 35f + seed % 30,
                Y = 35f + seed / 30 % 30,
            });
        }
        DemoSyncPosition(ctx, ctx.Sender);
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientDisconnected)]
    public static void Disconnected(ReducerContext ctx) => VoipOnDisconnect(ctx);

    [SpacetimeDB.Reducer]
    public static void DemoSetName(ReducerContext ctx, string name)
    {
        name = name.Trim();
        if (name.Length is 0 or > 24) throw new Exception("name must be 1-24 characters");
        var p = ctx.Db.DemoPlayer.Identity.Find(ctx.Sender) ?? throw new Exception("not connected");
        ctx.Db.DemoPlayer.Identity.Update(p with { Name = name });
    }

    /// <summary>Move on the campfire map. The module, not the client, tells voip where you are.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoMove(ReducerContext ctx, float x, float y)
    {
        if (!float.IsFinite(x) || !float.IsFinite(y)) throw new Exception("bad position");
        var p = ctx.Db.DemoPlayer.Identity.Find(ctx.Sender) ?? throw new Exception("not connected");
        ctx.Db.DemoPlayer.Identity.Update(p with { X = Math.Clamp(x, 0f, Map), Y = Math.Clamp(y, 0f, Map) });
        DemoSyncPosition(ctx, ctx.Sender);
    }

    static void DemoSyncPosition(ReducerContext ctx, Identity who)
    {
        if (ctx.Db.DemoPlayer.Identity.Find(who) is { } p) VoipSetPosition(ctx, who, new VoipVec3(p.X, p.Y, 0f));
    }

    static readonly Lazy<byte[]> DemoPage = new(() =>
    {
        using var s = typeof(Module).Assembly.GetManifestResourceStream("index.html")!;
        using var m = new MemoryStream();
        s.CopyTo(m);
        return m.ToArray();
    });

    [SpacetimeDB.HttpHandler]
    public static HttpResponse Page(HandlerContext ctx, HttpRequest req) =>
        new(200, HttpVersion.Http11,
            new List<HttpHeader> { new("content-type", "text/html; charset=utf-8"), new("cache-control", "no-cache") },
            new HttpBody(DemoPage.Value));

    [SpacetimeDB.HttpRouter]
    public static Router Routes() => Router.New().Get("/", Handlers.Page);
}
