# spacetimedb-voip-client

The browser side: mic → noise gate / push-to-talk → Opus (WebCodecs) → your `voip_send` reducer, and
`voip_packet` rows → one Opus decoder and one adaptive jitter buffer per speaker → speakers, with optional 3D panning
and distance fade for proximity rooms. It doesn't depend on your generated bindings, and it has no dependencies.

```ts
import { VoipClient, voipPacketQuery } from '@pogly/spacetimedb-voip-client';

const voip = new VoipClient({
  send: (seq, flags, data) => conn.reducers.voipSend({ seq, flags, data }),
  // frameMs: 20, bitrate: 24000, mode: 'voice' | 'ptt', gateDb: -50, hangoverMs: 300, prerollFrames: 2,
  // jitter: { minMs: 40, maxMs: 400, startMs: 80 }, echoCancellation / noiseSuppression / autoGainControl: true
});
conn.db.voipPacket.onInsert((_ctx, p) => voip.receive(p));
conn.subscriptionBuilder().subscribe([voipPacketQuery(myPeerId)]);   // TS submodule: voipPacketQuery(id, 'voip.packet')

button.onclick = () => voip.start();          // opens the mic; browsers need a user gesture for audio
voip.onTalking = (speakerId, talking) => {};  // speakerId = voip_peer.id
voip.onMicLevel = (dbfs) => {};
voip.setMode('ptt'); voip.setPushToTalk(true);
voip.setMuted(true);                          // also call voip_set_muted so others see it
voip.setVolume(speakerId, 1.5);
voip.removeSpeaker(speakerId);                // when they leave your room

// Proximity rooms: turn on spatial audio with the room's range, and keep the listener in sync with your position
voip.setSpatial({ range: room.range });
voip.setListener({ x, y, z });
```

It needs WebCodecs Opus (`AudioEncoder`/`AudioDecoder`) and AudioWorklet. It's tested in Chromium.

```bash
npm install @pogly/spacetimedb-voip-client
```
