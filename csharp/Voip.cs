// Voip.cs: voice chat for SpacetimeDB C# modules, one drop-in file.
//
// The C# twin of rust/voip.rs and the spacetimedb-voip TypeScript submodule. Same tables,
// reducers and packet format, so the same clients work against all three.
//
// Drop this file into your module project and call the connect/disconnect hooks from your
// lifecycle reducers:
//
//     [Reducer(ReducerKind.ClientConnected)]
//     public static void Connected(ReducerContext ctx) => VoipOnConnect(ctx);
//
//     [Reducer(ReducerKind.ClientDisconnected)]
//     public static void Disconnected(ReducerContext ctx) => VoipOnDisconnect(ctx);
//
// Rooms: everyone in a room hears everyone. Spatial rooms: you hear people within `Range`,
// set positions with VoipSetPosition from your own movement code. Packets go through the
// voip_packet event table and row-level security delivers each one only to its listeners.
// The module never decodes audio; clients encode Opus and the module routes the bytes.

#pragma warning disable STDB_UNSTABLE
#nullable enable

using SpacetimeDB;

/// <summary>Tunables. Defaults suit 20-60 ms Opus frames at up to ~40 kbit/s.</summary>
[SpacetimeDB.Type]
public partial struct VoipSettings
{
    /// <summary>Largest accepted packet payload, in bytes.</summary>
    public uint MaxPacketBytes;
    /// <summary>Token-bucket refill per speaker, bytes/s (payload + PacketOverhead). 0 = off.</summary>
    public uint RateBytesPerSec;
    /// <summary>Token-bucket size: how far a speaker can burst above the rate.</summary>
    public uint BurstBytes;
    /// <summary>Bytes charged per packet on top of its payload.</summary>
    public uint PacketOverhead;
    /// <summary>Whether clients may create (transient) rooms with voip_create_room.</summary>
    public bool ClientsCreateRooms;

    public static VoipSettings Default => new()
    {
        MaxPacketBytes = 1500,
        RateBytesPerSec = 8_000,
        BurstBytes = 16_000,
        PacketOverhead = 32,
        ClientsCreateRooms = true,
    };
}

/// <summary>Options for VoipNewRoom.</summary>
public record struct VoipRoomOptions(bool Spatial = false, float Range = 30f, bool Locked = false, uint MaxPeers = 0);

[SpacetimeDB.Type]
public partial struct VoipVec3
{
    public float X;
    public float Y;
    public float Z;

    public VoipVec3(float x, float y, float z)
    {
        X = x;
        Y = y;
        Z = z;
    }
}

[SpacetimeDB.Type]
public partial struct VoipCellCoord
{
    public int X;
    public int Y;
    public int Z;
}

public static partial class Module
{
    /// <summary>flags bit: the last packet of a talk spurt.</summary>
    public const byte VOIP_FLAG_END = 1;

    /// <summary>Top bit marks spatial-cell audiences, so they never collide with room ids.</summary>
    const ulong VoipCellBit = 1UL << 63;
    const int VoipMaxRoomName = 32;

    // -----------------------------------------------------------------------
    // Tables
    // -----------------------------------------------------------------------

    [SpacetimeDB.Table(Accessor = "VoipConfig")]
    public partial struct VoipConfig
    {
        [SpacetimeDB.PrimaryKey]
        public byte Key;
        public VoipSettings Settings;
    }

    [SpacetimeDB.Table(Accessor = "VoipRoom", Public = true)]
    public partial struct VoipRoom
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Unique]
        public string Name;
        public bool Spatial;
        public float Range;
        public bool Locked;
        public uint MaxPeers;
        /// <summary>null for rooms your module created (persistent). Client rooms are deleted when empty.</summary>
        public Identity? Owner;
        public Timestamp CreatedAt;
    }

    /// <summary>Everyone who has used voice. Id tags their packets (stable, never 0).</summary>
    [SpacetimeDB.Table(Accessor = "VoipPeer", Public = true)]
    public partial struct VoipPeer
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        [SpacetimeDB.Unique, SpacetimeDB.AutoInc]
        public uint Id;
        /// <summary>0 = not in a room.</summary>
        [SpacetimeDB.Index.BTree]
        public ulong RoomId;
        public bool Online;
        public bool Muted;
        public bool Deafened;
        public bool ServerMuted;
        public Timestamp JoinedAt;
    }

    /// <summary>
    /// Which audiences each client hears. Public because RLS on event tables can only join
    /// public tables without RLS of their own (SpacetimeDB 2.11). Keys are opaque.
    /// </summary>
    [SpacetimeDB.Table(Accessor = "VoipListen", Public = true)]
    public partial struct VoipListen
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public Identity Listener;
        [SpacetimeDB.Index.BTree]
        public ulong Audience;
    }

    /// <summary>Hot per-speaker state, read (and with rate limiting, written) once per packet.</summary>
    [SpacetimeDB.Table(Accessor = "VoipSpeaker")]
    public partial struct VoipSpeaker
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public uint PeerId;
        /// <summary>Where this speaker's packets go; 0 = nowhere.</summary>
        public ulong Audience;
        public bool CanSpeak;
        public bool Spatial;
        public VoipVec3? Pos;
        public VoipCellCoord? Cell;
        public double Tokens;
        public Timestamp RefilledAt;
    }

    /// <summary>Spatial cells, numbered as first used, so audience keys reveal no coordinates.</summary>
    [SpacetimeDB.Table(Accessor = "VoipCell")]
    [SpacetimeDB.Index.BTree(Accessor = "ByCoord", Columns = new[] { nameof(RoomId), nameof(X), nameof(Y), nameof(Z) })]
    public partial struct VoipCell
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public ulong RoomId;
        public int X;
        public int Y;
        public int Z;
    }

    /// <summary>
    /// Voice packets: an event table, broadcast on commit and never stored as state.
    /// Do NOT index it: that flips the RLS join so the event table becomes the lookup side.
    /// </summary>
    [SpacetimeDB.Table(Accessor = "VoipPacket", Public = true, Event = true)]
    public partial struct VoipPacket
    {
        public ulong Audience;
        /// <summary>The speaker's voip_peer.id.</summary>
        public uint Speaker;
        public uint Seq;
        public byte Flags;
        /// <summary>Spatial rooms only: where the speaker was.</summary>
        public VoipVec3? Pos;
        /// <summary>One encoded frame (Opus).</summary>
        public byte[] Data;
    }

    /// <summary>
    /// Deliver a packet only to clients listening to its audience. `speaker != 0` is always
    /// true; it anchors the join so the planner scans the event table. Clients add
    /// `WHERE speaker != (own id)` to skip their own packets.
    /// </summary>
    [SpacetimeDB.ClientVisibilityFilter]
    public static readonly Filter VOIP_PACKET_FILTER = new Filter.Sql(
        "SELECT voip_packet.* FROM voip_packet JOIN voip_listen ON voip_packet.audience = voip_listen.audience WHERE voip_listen.listener = :sender AND voip_packet.speaker != 0"
    );

    // -----------------------------------------------------------------------
    // Library API: call these from your own reducers
    // -----------------------------------------------------------------------

    /// <summary>Store settings (from Init, or any time later). Without a call, defaults apply.</summary>
    public static void VoipConfigure(ReducerContext ctx, VoipSettings settings)
    {
        var row = new VoipConfig { Key = 0, Settings = settings };
        if (ctx.Db.VoipConfig.Key.Find(0) is not null) ctx.Db.VoipConfig.Key.Update(row);
        else ctx.Db.VoipConfig.Insert(row);
    }

    public static VoipSettings VoipGetSettings(ReducerContext ctx) =>
        ctx.Db.VoipConfig.Key.Find(0)?.Settings ?? VoipSettings.Default;

    /// <summary>Create a persistent room owned by the module. Returns its id.</summary>
    public static ulong VoipNewRoom(ReducerContext ctx, string name, VoipRoomOptions options) =>
        VoipInsertRoom(ctx, name, options, null);

    /// <summary>Delete a room, removing everyone from it.</summary>
    public static void VoipDeleteRoom(ReducerContext ctx, ulong roomId)
    {
        foreach (var peer in ctx.Db.VoipPeer.RoomId.Filter(roomId).ToList())
        {
            ctx.Db.VoipPeer.Identity.Update(peer with { RoomId = 0 });
            VoipRefresh(ctx, peer.Identity);
        }
        foreach (var cell in ctx.Db.VoipCell.RoomId.Filter(roomId).ToList())
        {
            ctx.Db.VoipCell.Id.Delete(cell.Id);
        }
        ctx.Db.VoipRoom.Id.Delete(roomId);
    }

    /// <summary>Put someone in a room, bypassing Locked (your module decides who may join).</summary>
    public static void VoipJoinRoom(ReducerContext ctx, Identity who, ulong roomId)
    {
        var room = ctx.Db.VoipRoom.Id.Find(roomId) ?? throw new Exception("no such room");
        var peer = VoipEnsurePeer(ctx, who);
        if (peer.RoomId == roomId) return;
        if (room.MaxPeers > 0 && ctx.Db.VoipPeer.RoomId.Filter(roomId).Count() >= room.MaxPeers)
        {
            throw new Exception("room is full");
        }
        var old = peer.RoomId;
        ctx.Db.VoipPeer.Identity.Update(peer with { RoomId = roomId, JoinedAt = ctx.Timestamp });
        VoipRefresh(ctx, who);
        VoipCleanupRoom(ctx, old);
    }

    /// <summary>Take someone out of whatever room they're in.</summary>
    public static void VoipLeaveRoom(ReducerContext ctx, Identity who)
    {
        if (ctx.Db.VoipPeer.Identity.Find(who) is not { } peer || peer.RoomId == 0) return;
        var old = peer.RoomId;
        ctx.Db.VoipPeer.Identity.Update(peer with { RoomId = 0 });
        VoipRefresh(ctx, who);
        VoipCleanupRoom(ctx, old);
    }

    /// <summary>Set someone's position for proximity voice. Cheap while they stay in one cell.</summary>
    public static void VoipSetPosition(ReducerContext ctx, Identity who, VoipVec3 pos)
    {
        var peer = VoipEnsurePeer(ctx, who);
        var speaker = VoipEnsureSpeaker(ctx, peer);
        speaker.Pos = pos;
        var movedCell = speaker.Spatial
            && ctx.Db.VoipRoom.Id.Find(peer.RoomId) is { } room
            && !VoipSameCell(VoipCellOf(pos, room.Range), speaker.Cell);
        ctx.Db.VoipSpeaker.Identity.Update(speaker);
        if (movedCell) VoipRefresh(ctx, who);
    }

    /// <summary>Clear someone's position: they stop hearing and being heard in spatial rooms.</summary>
    public static void VoipClearPosition(ReducerContext ctx, Identity who)
    {
        if (ctx.Db.VoipSpeaker.Identity.Find(who) is not { } speaker) return;
        ctx.Db.VoipSpeaker.Identity.Update(speaker with { Pos = null });
        VoipRefresh(ctx, who);
    }

    /// <summary>Server mute (moderation): they can still hear, but their packets are rejected.</summary>
    public static void VoipSetServerMuted(ReducerContext ctx, Identity who, bool muted)
    {
        var peer = VoipEnsurePeer(ctx, who);
        ctx.Db.VoipPeer.Identity.Update(peer with { ServerMuted = muted });
        VoipRefresh(ctx, who);
    }

    /// <summary>Call from your ClientConnected reducer.</summary>
    public static void VoipOnConnect(ReducerContext ctx)
    {
        var peer = VoipEnsurePeer(ctx, ctx.Sender);
        if (!peer.Online) ctx.Db.VoipPeer.Identity.Update(peer with { Online = true });
    }

    /// <summary>Call from your ClientDisconnected reducer.</summary>
    public static void VoipOnDisconnect(ReducerContext ctx)
    {
        var who = ctx.Sender;
        if (ctx.Db.VoipPeer.Identity.Find(who) is not { } peer) return;
        var old = peer.RoomId;
        ctx.Db.VoipPeer.Identity.Update(peer with { RoomId = 0, Online = false, Muted = false, Deafened = false });
        VoipRefresh(ctx, who);
        ctx.Db.VoipSpeaker.Identity.Delete(who);
        VoipCleanupRoom(ctx, old);
    }

    // -----------------------------------------------------------------------
    // Client reducers
    // -----------------------------------------------------------------------

    /// <summary>Create a transient room (deleted when empty) and join it.</summary>
    [SpacetimeDB.Reducer]
    public static void VoipCreateRoom(ReducerContext ctx, string name, bool spatial, float range)
    {
        if (!VoipGetSettings(ctx).ClientsCreateRooms) throw new Exception("only the server can create rooms");
        var id = VoipInsertRoom(ctx, name, new VoipRoomOptions(Spatial: spatial, Range: range), ctx.Sender);
        VoipJoinRoom(ctx, ctx.Sender, id);
    }

    [SpacetimeDB.Reducer]
    public static void VoipJoin(ReducerContext ctx, ulong roomId)
    {
        var room = ctx.Db.VoipRoom.Id.Find(roomId) ?? throw new Exception("no such room");
        if (room.Locked) throw new Exception("room is locked");
        VoipJoinRoom(ctx, ctx.Sender, roomId);
    }

    [SpacetimeDB.Reducer]
    public static void VoipLeave(ReducerContext ctx) => VoipLeaveRoom(ctx, ctx.Sender);

    [SpacetimeDB.Reducer]
    public static void VoipSetMuted(ReducerContext ctx, bool muted)
    {
        var peer = VoipEnsurePeer(ctx, ctx.Sender);
        ctx.Db.VoipPeer.Identity.Update(peer with { Muted = muted });
        VoipRefresh(ctx, ctx.Sender);
    }

    /// <summary>Deafened clients stop receiving packets at all. Deafening also mutes.</summary>
    [SpacetimeDB.Reducer]
    public static void VoipSetDeafened(ReducerContext ctx, bool deafened)
    {
        var peer = VoipEnsurePeer(ctx, ctx.Sender);
        ctx.Db.VoipPeer.Identity.Update(peer with { Deafened = deafened });
        VoipRefresh(ctx, ctx.Sender);
    }

    /// <summary>A transient room's owner can server-mute people in it.</summary>
    [SpacetimeDB.Reducer]
    public static void VoipModerate(ReducerContext ctx, Identity target, bool muted)
    {
        var me = ctx.Db.VoipPeer.Identity.Find(ctx.Sender) ?? throw new Exception("not in a room");
        var room = ctx.Db.VoipRoom.Id.Find(me.RoomId) ?? throw new Exception("not in a room");
        if (room.Owner != ctx.Sender) throw new Exception("only the room's owner can moderate");
        var them = ctx.Db.VoipPeer.Identity.Find(target) ?? throw new Exception("no such peer");
        if (them.RoomId != room.Id) throw new Exception("they're not in your room");
        VoipSetServerMuted(ctx, target, muted);
    }

    /// <summary>Send one encoded frame to the sender's current audience.</summary>
    [SpacetimeDB.Reducer]
    public static void VoipSend(ReducerContext ctx, uint seq, byte flags, byte[] data)
    {
        var speaker = ctx.Db.VoipSpeaker.Identity.Find(ctx.Sender) ?? throw new Exception("not in a voice room");
        if (!speaker.CanSpeak || speaker.Audience == 0)
        {
            throw new Exception("can't speak here (muted, or no position in a spatial room)");
        }
        var s = VoipGetSettings(ctx);
        if (data.Length > s.MaxPacketBytes) throw new Exception("packet too large");
        if (s.RateBytesPerSec > 0)
        {
            var elapsedUs = ctx.Timestamp.MicrosecondsSinceUnixEpoch - speaker.RefilledAt.MicrosecondsSinceUnixEpoch;
            var refill = Math.Max(0, elapsedUs) / 1e6 * s.RateBytesPerSec;
            var tokens = Math.Min(speaker.Tokens + refill, s.BurstBytes);
            var cost = (double)(data.Length + s.PacketOverhead);
            if (tokens < cost) throw new Exception("rate limited");
            ctx.Db.VoipSpeaker.Identity.Update(speaker with { Tokens = tokens - cost, RefilledAt = ctx.Timestamp });
        }
        ctx.Db.VoipPacket.Insert(new VoipPacket
        {
            Audience = speaker.Audience,
            Speaker = speaker.PeerId,
            Seq = seq,
            Flags = flags,
            Pos = speaker.Spatial ? speaker.Pos : null,
            Data = data,
        });
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    static ulong VoipInsertRoom(ReducerContext ctx, string name, VoipRoomOptions options, Identity? owner)
    {
        name = name.Trim();
        if (name.Length == 0 || name.Length > VoipMaxRoomName)
        {
            throw new Exception($"room name must be 1-{VoipMaxRoomName} characters");
        }
        if (ctx.Db.VoipRoom.Name.Find(name) is not null) throw new Exception("a room with that name exists");
        if (options.Spatial && !(float.IsFinite(options.Range) && options.Range > 0))
        {
            throw new Exception("spatial rooms need a positive range");
        }
        var room = ctx.Db.VoipRoom.Insert(new VoipRoom
        {
            Id = 0,
            Name = name,
            Spatial = options.Spatial,
            Range = options.Range,
            Locked = options.Locked,
            MaxPeers = options.MaxPeers,
            Owner = owner,
            CreatedAt = ctx.Timestamp,
        });
        if ((room.Id & VoipCellBit) != 0) throw new Exception("room id space exhausted");
        return room.Id;
    }

    /// <summary>Delete a client-created room once it's empty.</summary>
    static void VoipCleanupRoom(ReducerContext ctx, ulong roomId)
    {
        if (roomId == 0 || ctx.Db.VoipRoom.Id.Find(roomId) is not { } room) return;
        if (room.Owner is not null && !ctx.Db.VoipPeer.RoomId.Filter(roomId).Any()) VoipDeleteRoom(ctx, roomId);
    }

    static VoipPeer VoipEnsurePeer(ReducerContext ctx, Identity who) =>
        ctx.Db.VoipPeer.Identity.Find(who) ?? ctx.Db.VoipPeer.Insert(new VoipPeer
        {
            Identity = who,
            Id = 0,
            RoomId = 0,
            Online = true,
            JoinedAt = ctx.Timestamp,
        });

    static VoipSpeaker VoipEnsureSpeaker(ReducerContext ctx, VoipPeer peer) =>
        ctx.Db.VoipSpeaker.Identity.Find(peer.Identity) ?? ctx.Db.VoipSpeaker.Insert(new VoipSpeaker
        {
            Identity = peer.Identity,
            PeerId = peer.Id,
            Audience = 0,
            Tokens = VoipGetSettings(ctx).BurstBytes,
            RefilledAt = ctx.Timestamp,
        });

    static VoipCellCoord VoipCellOf(VoipVec3 pos, float range)
    {
        int C(float v) => (int)Math.Clamp(MathF.Floor(v / range), int.MinValue, int.MaxValue);
        return new VoipCellCoord { X = C(pos.X), Y = C(pos.Y), Z = C(pos.Z) };
    }

    // Field by field on purpose: the generated Equals(object) on [SpacetimeDB.Type] structs
    // recurses forever in SpacetimeDB 2.11 (it calls itself with a boxed Nullable<T>).
    static bool VoipSameCell(VoipCellCoord a, VoipCellCoord? b) =>
        b is { } c && a.X == c.X && a.Y == c.Y && a.Z == c.Z;

    static ulong VoipCellAudience(ReducerContext ctx, ulong roomId, VoipCellCoord c)
    {
        foreach (var cell in ctx.Db.VoipCell.ByCoord.Filter((roomId, c.X, c.Y, c.Z)))
        {
            return cell.Id | VoipCellBit;
        }
        return ctx.Db.VoipCell.Insert(new VoipCell { Id = 0, RoomId = roomId, X = c.X, Y = c.Y, Z = c.Z }).Id | VoipCellBit;
    }

    /// <summary>Recompute where someone's packets go and what they hear; sync voip_listen.</summary>
    static void VoipRefresh(ReducerContext ctx, Identity who)
    {
        if (ctx.Db.VoipPeer.Identity.Find(who) is not { } peer) return;
        VoipRoom? room = peer.RoomId != 0 && peer.Online ? ctx.Db.VoipRoom.Id.Find(peer.RoomId) : null;
        var speaker = VoipEnsureSpeaker(ctx, peer);

        ulong audience = 0;
        var hears = new List<ulong>();
        speaker.Spatial = false;
        speaker.Cell = null;
        if (room is { } r)
        {
            if (!r.Spatial)
            {
                audience = r.Id;
                hears.Add(r.Id);
            }
            else if (speaker.Pos is { } pos)
            {
                var c = VoipCellOf(pos, r.Range);
                speaker.Spatial = true;
                speaker.Cell = c;
                audience = VoipCellAudience(ctx, r.Id, c);
                for (var dx = -1; dx <= 1; dx++)
                for (var dy = -1; dy <= 1; dy++)
                for (var dz = -1; dz <= 1; dz++)
                {
                    var n = new VoipCellCoord { X = Sat(c.X, dx), Y = Sat(c.Y, dy), Z = Sat(c.Z, dz) };
                    hears.Add(VoipCellAudience(ctx, r.Id, n));
                }
            }
        }
        if (peer.Deafened) hears.Clear();
        speaker.Audience = audience;
        speaker.CanSpeak = audience != 0 && !peer.Muted && !peer.Deafened && !peer.ServerMuted;
        ctx.Db.VoipSpeaker.Identity.Update(speaker);

        // Sync listen rows: delete what's no longer heard, add what's new.
        var want = new HashSet<ulong>(hears);
        var current = ctx.Db.VoipListen.Listener.Filter(who).ToList();
        foreach (var row in current)
        {
            if (!want.Remove(row.Audience)) ctx.Db.VoipListen.Id.Delete(row.Id);
        }
        foreach (var a in want)
        {
            ctx.Db.VoipListen.Insert(new VoipListen { Id = 0, Listener = who, Audience = a });
        }

        static int Sat(int v, int d) => (int)Math.Clamp((long)v + d, int.MinValue, int.MaxValue);
    }
}
