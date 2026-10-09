// One client API over both schema flavours:
//   flat: Rust and C# modules       (tables `voip_room`, reducers `voip_join`, ...)
//   ns:   the TypeScript submodule  (tables `voip.room`, reducers `voip.join`, ...)
// Rows, columns and indexes are identical; only the table and reducer names differ.
import type { Identity } from 'spacetimedb';
import { DbConnection as FlatConnection } from './bindings/index';
import { DbConnection as NsConnection } from './bindings-ns/index';

export type Flavor = 'flat' | 'ns';
type Db = FlatConnection['db'];
export type Conn = FlatConnection;

export interface Voice {
  flavor: Flavor;
  conn: Conn;
  identity: Identity;
  token: string;
  room: Db['voipRoom'];
  peer: Db['voipPeer'];
  packet: Db['voipPacket'];
  listen: Db['voipListen'];
  player: Db['demoPlayer'];
  /** SQL names, for subscriptions. */
  sql: { room: string; peer: string; packet: string; listen: string; player: string };
  join(roomId: bigint): Promise<void>;
  leave(): Promise<void>;
  send(seq: number, flags: number, data: Uint8Array): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setDeafened(deafened: boolean): Promise<void>;
  moderate(target: Identity, muted: boolean): Promise<void>;
  createRoom(name: string, spatial: boolean, range: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  setName(name: string): Promise<void>;
}

export function connect(
  flavor: Flavor,
  host: string,
  db: string,
  token?: string,
  onDisconnect?: () => void
): Promise<Voice> {
  const Builder = flavor === 'ns' ? NsConnection : FlatConnection;
  return new Promise((resolve, reject) => {
    Builder.builder()
      .withUri(host)
      .withDatabaseName(db)
      .withToken(token)
      .onConnect((c, identity, tok) => resolve(wrap(flavor, c as unknown as Conn, identity, tok)))
      .onDisconnect(() => onDisconnect?.())
      .onConnectError((_c, e) => reject(e))
      .build();
  });
}

function wrap(flavor: Flavor, conn: Conn, identity: Identity, token: string): Voice {
  const ns = flavor === 'ns';
  const d = conn.db as any;
  const r = conn.reducers as any;
  const red = (flat: string, nsName: string) => r[ns ? nsName : flat];
  return {
    flavor,
    conn,
    identity,
    token,
    room: ns ? d['voip.room'] : d.voipRoom,
    peer: ns ? d['voip.peer'] : d.voipPeer,
    packet: ns ? d['voip.packet'] : d.voipPacket,
    listen: ns ? d['voip.listen'] : d.voipListen,
    player: d.demoPlayer,
    sql: ns
      ? { room: 'voip.room', peer: 'voip.peer', packet: 'voip.packet', listen: 'voip.listen', player: 'demo_player' }
      : { room: 'voip_room', peer: 'voip_peer', packet: 'voip_packet', listen: 'voip_listen', player: 'demo_player' },
    join: (roomId) => red('voipJoin', 'voip.join')({ roomId }),
    leave: () => red('voipLeave', 'voip.leave')({}),
    send: (seq, flags, data) => red('voipSend', 'voip.send')({ seq, flags, data }),
    setMuted: (muted) => red('voipSetMuted', 'voip.setMuted')({ muted }),
    setDeafened: (deafened) => red('voipSetDeafened', 'voip.setDeafened')({ deafened }),
    moderate: (target, muted) => red('voipModerate', 'voip.moderate')({ target, muted }),
    createRoom: (name, spatial, range) => red('voipCreateRoom', 'voip.createRoom')({ name, spatial, range }),
    move: (x, y) => r.demoMove({ x, y }),
    setName: (name) => r.demoSetName({ name }),
  };
}
