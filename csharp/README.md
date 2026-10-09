# Voip.cs: voice chat for C# modules

One file. Add [`Voip.cs`](Voip.cs) to your module project (or link it, like
[`demo/csharp/StdbModule.csproj`](../demo/csharp/StdbModule.csproj) does). It uses row-level security, so the file
starts with `#pragma warning disable STDB_UNSTABLE`.

```csharp
public static partial class Module
{
    [Reducer(ReducerKind.Init)]
    public static void Init(ReducerContext ctx)
    {
        VoipConfigure(ctx, VoipSettings.Default);                    // optional
        VoipNewRoom(ctx, "Lobby", new VoipRoomOptions());
        VoipNewRoom(ctx, "Proximity", new VoipRoomOptions(Spatial: true, Range: 30f));
    }

    [Reducer(ReducerKind.ClientConnected)]
    public static void Connected(ReducerContext ctx) => VoipOnConnect(ctx);

    [Reducer(ReducerKind.ClientDisconnected)]
    public static void Disconnected(ReducerContext ctx) => VoipOnDisconnect(ctx);
}
```

A complete module is in [`demo/csharp`](../demo/csharp/Lib.cs). It builds with NativeAOT-LLVM (.NET 10), and
`Voip.cs` also builds on net8.

## What you get

The same reducers and tables as Rust (`voip_join`, `voip_send`, …, `voip_room`, `voip_peer`, `voip_packet`; see
[PROTOCOL.md](../docs/PROTOCOL.md)). C# canonicalises to the same names, so the same clients work with both.

| Function | |
|---|---|
| `VoipConfigure(ctx, VoipSettings)` | Size cap, rate limit, whether clients can create rooms |
| `VoipNewRoom(ctx, name, VoipRoomOptions) → ulong` | Persistent room. `Spatial`, `Range`, `Locked`, `MaxPeers` |
| `VoipDeleteRoom(ctx, id)` | |
| `VoipJoinRoom(ctx, who, roomId)` / `VoipLeaveRoom(ctx, who)` | Bypasses `Locked` |
| `VoipSetPosition(ctx, who, new VoipVec3(x, y, z))` | Call it from your movement code |
| `VoipClearPosition(ctx, who)` · `VoipSetServerMuted(ctx, who, bool)` | |
| `VoipOnConnect(ctx)` / `VoipOnDisconnect(ctx)` | Lifecycle hooks |

Gotcha we hit: don't call `Equals(object)` on a `[SpacetimeDB.Type]` struct in 2.11; the generated method recurses
forever ([details](../docs/FINDINGS.md#bug-c-generated-equalsobject-recurses-forever-on-structs)).
