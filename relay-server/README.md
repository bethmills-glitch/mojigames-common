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
npm run smoke-test        # host / join / relay / ping / errors / leave / room closing, plus
                          # protocol v2: code lengths, app ids, kick, X-Forwarded-For, wrong-code pause
npm run test:reliability  # starts its OWN relays (1.5 s heartbeat limit) — no server needed
```

**Never point the smoke test at the live relay** (`RELAY_URL=wss://…`): it deliberately trips
the rate limits.

`test:reliability` checks the timing rules below with real sockets, and — on a Node that can
load TypeScript (22.18+ / 23.6+) — drives the real `OnlineTransport` against the relay too.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on. |
| `HEARTBEAT_TIMEOUT_MS` | `150000` | How long a client that sends app-level pings may stay silent before it is dropped (see *Heartbeats*). |
| `XFF_TRUSTED_HOPS` | `0` | Which `X-Forwarded-For` entry is the client (see *Rate limits*). `0` = the first (leftmost) one; `N` = the Nth from the right. |
| `MAX_FAILED_JOINS_PER_IP` | `20` | Wrong codes one address may try per minute before its joins are paused. |
| `FAILED_JOIN_BLOCK_MS` | `120000` | How long that pause lasts. |

## Wire protocol

JSON text frames over a WebSocket.

**Client → server**

| Message | Meaning |
|---|---|
| `{type:"host", size?, v?, app?}` | Create a room. `size` (2–8, default 2) is the player cap. `v: 2` (protocol v2) gets a **6-character** code; without it, 4. `app` tags the room with its game (see *Protocol v2*). |
| `{type:"join", code, app?}` | Join the room with that code (4 or 6 characters; case and spaces don't matter). `app` = the joiner's game. |
| `{type:"msg", data}` | Relay `data` to the other player(s) in the room. |
| `{type:"ping"}` | Liveness check — answered with `{type:"pong"}`. Sending one also opts this connection into the silence rule (see *Heartbeats*). |
| `{type:"kick", peerId}` | **Host only** (v2): remove that player. Silently ignored from anyone else. |

**Server → client**

| Message | Meaning |
|---|---|
| `{type:"hosted", code, peerId}` | Your room was created; `code` is the share code. |
| `{type:"joined", code, peerId, peers}` | You joined; `peers` lists who was already there (the host first). |
| `{type:"peer-join", peerId}` | Someone joined your room. |
| `{type:"peer-leave", peerId}` | Someone left your room (or was dropped for silence). |
| `{type:"msg", from, data}` | A message relayed from peer `from`. |
| `{type:"error", reason, code?}` | `no-room`, `room-full`, `not-in-room`, `bad-json`, `bad-type`; v2 adds `wrong-app` (another game's room), `too-many-tries` (this address is paused for guessing), `kicked` (the host removed you, or you tried to re-join after that). |
| `{type:"pong"}` | Reply to a `ping`. |

## Rooms

A room is created on `host`. **It closes when its host disconnects**: the guests still in it
are told (`peer-leave`) exactly as before and can still message each other, but the code stops
working — a later `join` gets `no-room`, the same answer as a code that never existed. Every
game is host-authoritative, so a room without its host can never start again; before this, a
friend arriving by the old code or share link was seated in it and waited forever. (Retrying
a closed room's code does not count toward the wrong-code limit.) A room is deleted once the
last player leaves.

## Protocol v2 (2026-10-10) — kids' safety

Three apps share this one relay: **Crack the Clip** (formerly HitMoji, adult trivia),
**Mojino** (an 18+ casino party game) and **Mojiventure** (a children's game). v2 adds:

1. **6-character codes.** 4 characters from the 30-symbol alphabet is 810,000 codes — a script
   can sweep that. A host that sends `v: 2` gets 6 (729 million). Old hosts still get 4; joins
   accept both (the length tells them apart, so they never collide).
2. **App ids.** `app` on `host` and `join` (`cracktheclip`, `mojino`, `mojiventure`; lower-case
   letters/digits/dashes; anything malformed counts as "none"). The room remembers its host's app
   and a mismatched join gets `wrong-app` (which counts as a wrong code toward the limits, and
   doesn't say which game the room is). It's a rail against *mistakes* — anyone can send any
   string — the real protection against strangers is the long code plus the limits below.
3. **Rate limits keyed on the real client** (X-Forwarded-For) instead of Render's proxy, and a
   **per-address wrong-code pause** — see *Rate limits*.
4. **Kick** — the host can remove a player (`{type:"kick", peerId}`). The player gets
   `error: kicked` (their socket is NOT closed, so their app can say why instead of "connection
   lost"), everyone else gets an ordinary `peer-leave`, and that connection can't re-join the room.

Every v2 field is optional, so builds from before it work exactly as they did.

### Who may join whom

"Legacy" = a build from before v2 (sends no `app`, no `v`). Mojiventure is **strict**
(`STRICT_APPS` in server.js): it has never shipped without `app`, so "no app" is always some
other game.

| Room created by ↓ \ Guest → | legacy guest | Crack the Clip guest | Mojino guest | Mojiventure guest |
|---|---|---|---|---|
| **legacy host** (4-char code, no app) | ✅ joins (as today) | ✅ joins (transition) | ✅ joins (transition) | ❌ `wrong-app` |
| **Crack the Clip v2 host** (6-char) | ✅ joins (transition) | ✅ joins | ❌ `wrong-app` | ❌ `wrong-app` |
| **Mojino v2 host** (6-char) | ✅ joins (transition) | ❌ `wrong-app` | ✅ joins | ❌ `wrong-app` |
| **Mojiventure v2 host** (6-char) | ❌ `wrong-app` | ❌ `wrong-app` | ❌ `wrong-app` | ✅ joins |

A v2 host that sends `v: 2` but no `app` gets a 6-char code and behaves like a legacy host
for the app rules. Once no legacy Crack the Clip / Mojino builds remain in use, add them to
`STRICT_APPS` to close the "transition" cells.

**New client, old relay** (if an app ever ships before the relay is deployed): the relay ignores
`v`/`app` — 4-character codes, no app separation — and answers `kick` with `bad-type`, which
`OnlineTransport` swallows. Nothing breaks; the protection simply isn't there yet.

### Rollout order

1. **Deploy the relay first** (push this branch to `main` → Render redeploys). It accepts old and
   new clients, so nothing needs to change in the apps at the same time. A redeploy ends every
   open game — do it when nobody is playing.
2. Check it: `curl https://mojigames-relay.onrender.com/whoami` (and the same with
   `-H 'X-Forwarded-For: 1.2.3.4'`) — see *Rate limits* for what to look for.
3. **Then each app**: bump its `mojigames-common` pin (`npm update mojigames-common`), pass its
   `app` id — `new OnlineTransport({ url: RELAY_URL, app: 'mojiventure' })` — and give its screens
   words for `wrong-app`, `too-many-tries` and `kicked`. Its code boxes already take 6 characters.
4. **Then builds** (EAS) and the web deploys. Mojiventure must ship with `app` set from its very
   first release — the relay treats an app-less client as "not Mojiventure".

## Rate limits

- **Per connection:** 5 wrong codes and the relay closes the socket.
- **Per address, connections:** 20 new connections per 10 s.
- **Per address, wrong codes:** `MAX_FAILED_JOINS_PER_IP` (20) wrong codes — or `wrong-app`s —
  within a minute pause every join from that address for `FAILED_JOIN_BLOCK_MS` (2 min):
  `error: too-many-tries`, even for a real code (otherwise the pause would still say which codes
  are real). 20, not 10, because one address can be a family on home Wi-Fi or a classroom.
  Closed or full rooms don't count (the player had the right code).

**"Address"** used to be the socket's peer — on Render that's Render's proxy, so the whole world
shared one bucket. It is now read from `X-Forwarded-For`. Render's proxy *appends* to that header
and doesn't strip what the client sent, so by default (`XFF_TRUSTED_HOPS=0`) the relay takes the
**first** entry (Render's documented position for the real client): a client that forges the
header only earns itself fresh buckets (each socket is still capped at 5 wrong codes) — or could
pause joins for an address it already knows. To close that, find how many entries Render adds:
`curl -H 'X-Forwarded-For: 1.2.3.4' https://mojigames-relay.onrender.com/whoami` — if the result
is e.g. `"1.2.3.4, <your real IP>"`, the real address is 1st from the right, so set
`XFF_TRUSTED_HOPS=1` in Render's environment settings (no code change). A malformed entry falls
back to the socket address. `GET /whoami` only ever shows the caller's own request.

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

### Hosting plan (Render free tier)

The live relay is on Render's **free** plan, which sleeps after ~15 minutes with no traffic and
takes **~50 seconds** to wake on the next connection (`OnlineTransport` waits up to 70 s, so it
works — the first host of the evening just sees a long "connecting…"). While a room is open the
15 s pings keep it awake.

**Recommendation: upgrade to the paid "Starter" instance (~$7/month) before Mojiventure
launches.** A child tapping "Play with a friend" will not wait 50 seconds — they'll think it's
broken — and a parent reviewing the app may well hit exactly that first, cold connection. The
paid plan never sleeps. It doesn't change anything else (a redeploy still ends open games). It's
a one-line change (`plan: starter` in `render.yaml`, or the Render dashboard) and a billing
decision for Beth.
