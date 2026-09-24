# Mojigames — relay server

A tiny WebSocket relay that backs **online multiplayer**. Players host a room (the server
mints a short share code) or join one by code; the server then relays every message
between the players in that room.

It is **game-agnostic** — it never looks inside the `data` payload, it just forwards it —
so the whole game protocol lives in the client (`mojigames-common/multiplayer`). One
deployed relay can back the online play of every Mojigames game at once.

## Run it

```bash
cd relay-server
npm install
npm start            # listens on :8787 (override with the PORT env var)
```

Verify it with the smoke test (in a second shell, while the server runs):

```bash
npm run smoke-test        # exercises host / join / relay / ping / errors / leave / room closing
npm run test:reliability  # starts its OWN relays (1.5 s heartbeat limit) — no server needed
```

`test:reliability` checks the timing rules below with real sockets, and — on a Node that can
load TypeScript (22.18+ / 23.6+) — drives the real `OnlineTransport` against the relay too.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on. |
| `HEARTBEAT_TIMEOUT_MS` | `45000` | How long a client that sends app-level pings may stay silent before it is dropped (see *Heartbeats*). |

## Wire protocol

JSON text frames over a WebSocket.

**Client → server**

| Message | Meaning |
|---|---|
| `{type:"host", size?}` | Create a room. `size` (2–8, default 2) is the player cap. |
| `{type:"join", code}` | Join the room with that code. |
| `{type:"msg", data}` | Relay `data` to the other player(s) in the room. |
| `{type:"ping"}` | Liveness check — answered with `{type:"pong"}`. Sending one also opts this connection into the silence rule (see *Heartbeats*). |

**Server → client**

| Message | Meaning |
|---|---|
| `{type:"hosted", code, peerId}` | Your room was created; `code` is the share code. |
| `{type:"joined", code, peerId, peers}` | You joined; `peers` lists who was already there (the host first). |
| `{type:"peer-join", peerId}` | Someone joined your room. |
| `{type:"peer-leave", peerId}` | Someone left your room (or was dropped for silence). |
| `{type:"msg", from, data}` | A message relayed from peer `from`. |
| `{type:"error", reason, code?}` | `no-room`, `room-full`, `not-in-room`, `bad-json`, `bad-type`. |
| `{type:"pong"}` | Reply to a `ping`. |

## Rooms

A room is created on `host`. **It closes when its host disconnects**: the guests still in it
are told (`peer-leave`) exactly as before and can still message each other, but the code stops
working — a later `join` gets `no-room`, the same answer as a code that never existed. Every
game is host-authoritative, so a room without its host can never start again; before this, a
friend arriving by the old code or share link was seated in it and waited forever. (Retrying
a closed room's code does not count toward the wrong-code limit.) A room is deleted once the
last player leaves.

## Heartbeats

Two independent liveness rules run side by side:

- **WebSocket-level ping** every 30 s; a connection that hasn't answered by the next round is
  dropped (after 30–60 s). This works when the relay is reached directly (local dev, a plain server) — but
  **not on Render**: something in front of it (it answers as Cloudflare) swallows the pings, so
  on the live relay it never drops anyone.
- **App-level ping** (added 2026-09-24): `OnlineTransport` sends `{type:"ping"}` every 15 s
  while connected. Once a connection has sent one, going silent — no message of any kind — for
  `HEARTBEAT_TIMEOUT_MS` (150 s) gets it dropped, and its room is told with the usual
  `peer-leave`. That is how a player whose phone went to sleep, or whose app was put in the
  background (React Native pauses JS timers there), is noticed — so a room doesn't hang
  forever on a host or a turn that will never come. Connections that have **never** pinged
  (every app build from before this rule) are not subject to it, so old builds behave exactly
  as they always did.

Trade-off to know about: the relay cannot tell "asleep" from "in another app for a while". A
host who switches away for longer than the limit (to send the code in WhatsApp, say) loses the
room. Raise `HEARTBEAT_TIMEOUT_MS` if that turns out to matter more than quick drops.

A side effect worth having: the 15 s pings count as traffic, so Render's free instance no
longer goes to sleep while a room is open.

## Deploying (for release)

The server is a single dependency-light Node process — any host that runs Node works
(Render, Railway, Fly.io, Cloudflare, a small VPS, …). It binds the `PORT` env var, and a
plain HTTP GET returns `200 ok` for health checks. Each game points at it via the relay
URL it configures. Until it is deployed, run it locally and online play will use
`ws://localhost:8787`.

Rooms live in memory, so **a restart or redeploy ends every open game** (each player gets
"connection lost"). The live relay redeploys whenever `main` is pushed — push when nobody is
playing.
