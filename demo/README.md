# Demo

Voice rooms (**Lobby**, a locked **Staff** room, and any rooms visitors create) plus **Campfire**, a proximity room
on a 2D map: click or use WASD to walk, and voices fade and pan with distance. The same demo exists in all three
languages, and they share one web page ([`web/`](web)), which each module serves from its own HTTP route.

```bash
npm install && npm run build:web          # bundles web/ into web/dist/index.html
spacetime start                           # in another terminal
spacetime publish -s local voip -p demo/rust      # or demo/csharp, demo/typescript
open http://127.0.0.1:3000/v1/database/voip/route/
```

Open it in two browser windows to talk to yourself (the mic needs localhost or https). For a hosted copy of
`web/dist/index.html`, point it at a database with `?host=wss://maincloud.spacetimedb.com&db=<name>` (add
`&flavor=ns` for the TypeScript module). Other URL options: `?raw=1` turns off echo cancellation, noise suppression and
AGC; `?frame=40` uses 40 ms frames.

`scripts/e2e.sh rust|csharp|typescript` publishes a demo and runs the protocol and audio test suites against it.
