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
npm run smoke-test   # exercises host / join / relay / errors / leave
```

## Wire protocol

JSON text frames over a WebSocket.

**Client → server**

| Message | Meaning |
|---|---|
| `{type:"host", size?}` | Create a room. `size` (2–8, default 2) is the player cap. |
| `{type:"join", code}` | Join the room with that code. |
| `{type:"msg", data}` | Relay `data` to the other player(s) in the room. |
| `{type:"ping"}` | Liveness check — answered with `{type:"pong"}`. |

**Server → client**

| Message | Meaning |
|---|---|
| `{type:"hosted", code, peerId}` | Your room was created; `code` is the share code. |
| `{type:"joined", code, peerId, peers}` | You joined; `peers` lists who was already there. |
| `{type:"peer-join", peerId}` | Someone joined your room. |
| `{type:"peer-leave", peerId}` | Someone left your room. |
| `{type:"msg", from, data}` | A message relayed from peer `from`. |
| `{type:"error", reason, code?}` | `no-room`, `room-full`, `not-in-room`, `bad-json`, `bad-type`. |
| `{type:"pong"}` | Reply to a `ping`. |

Rooms are created on host, and deleted automatically once the last player leaves. The
server also pings every socket every 30s and drops any that stop responding.

## Deploying (for release)

The server is a single dependency-light Node process — any host that runs Node works
(Render, Railway, Fly.io, Cloudflare, a small VPS, …). It binds the `PORT` env var, and a
plain HTTP GET returns `200 ok` for health checks. Each game points at it via the relay
URL it configures. Until it is deployed, run it locally and online play will use
`ws://localhost:8787`.
