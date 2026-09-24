# mojigames-common

Shared infrastructure for the **Mojigames** family of emoji-themed games — extracted from
Emoji Encore so every game starts with the same plumbing instead of rebuilding it.

## What's in here

| Import | What it gives you |
|---|---|
| `mojigames-common/multiplayer` | The `Transport` abstraction, `OnlineTransport` (a WebSocket relay client with a built-in heartbeat), the `useMultiplayer` React hook (1v1), and `useParty` (N-player, size-capped rooms: roster + host-authoritative start + live progress, plus `endMatch()` to send everyone back to the same lobby so one room can run game after game, and a waitlist that deals a mid-game arrival into the next game). |
| `mojigames-common/nearby` | `NearbyTransport` — in-person play between two phones in the same room (Bluetooth / local Wi-Fi), no internet. It's a `Transport`, so it drops straight into `useMultiplayer`. |
| `mojigames-common/storage` | `createStorage()` — a namespaced key/value store with a versioned wipe, over AsyncStorage. |
| `relay-server/` | A small, game-agnostic WebSocket relay server. Deploy it once; every game's online play can share it. |

Everything here is **game-agnostic** — no game's catalog, scoring, or screens.

## Using it in a game

`mojigames-common` is consumed as a **git dependency**. In the game's `package.json`:

```json
"dependencies": {
  "mojigames-common": "github:bethmills-glitch/mojigames-common"
}
```

Run `npm install`, then import from the entry points:

```ts
import { useMultiplayer, useParty, OnlineTransport } from 'mojigames-common/multiplayer';
import { NearbyTransport } from 'mojigames-common/nearby';
import { createStorage } from 'mojigames-common/storage';
```

To pick up a change: push it to this repo, then run `npm update mojigames-common` in the
game.

### Peer dependencies

The game provides these — an Expo app already has them:

- `react`, `react-native`
- `@react-native-async-storage/async-storage` — for `storage`
- `expo-nearby-connections` — for `nearby` (optional; `nearby` degrades gracefully without it)

The package ships TypeScript source — the consuming app's bundler (Metro) and type-checker
handle it directly, so there is no build step.

### What a party screen should show (`useParty`)

When `status === 'error'`, `error` says why:

| `error` | Meaning | Clears by itself? |
|---|---|---|
| `no-room` | No room has that code — or its host has gone, so the room closed. | no |
| `room-full` | Every seat is taken. | no |
| `match-started` | A game was already running. The player stays in the room and is dealt into the next game when the host calls `endMatch()` or `nextMatch()` (a host on an older build: when its lobby re-opens). A plain second `start()` doesn't include them, so they keep waiting. | **yes** |
| `host-unresponsive` | Joined, but the host hasn't answered for 5 s (phone asleep, app in the background). | **yes**, if the host answers |
| `host-left` | The host disconnected; this device has hung up too. | no |
| `connection-lost` | This device lost its connection (including 40 s of silence from the relay). | no |
| `timeout` | The relay never answered the host/join request (70 s). | no |

`waitingForHost` is `true` exactly while the error is one of the two that clear by themselves —
show "waiting…" with a Cancel (`leave()`) rather than a failure; `status` returns to
`'connected'` on its own when the host answers. Nearby play adds its own reasons
(`no-peers-found`, `permission-denied`, `nearby-unavailable`, `connect-failed`).

For the host: `waitlist` lists the players waiting for the next game; `endMatch()` seats them,
and `nextMatch((roster) => payload)` is "Play again" straight from a match that deals them in
(a second `start()` can't — its payload was built before they were seated).

## Developing

```bash
npm install
npm run typecheck   # tsc — type-check the source
npm test            # jest — run the unit tests
```

The relay server is its own mini-package — see [`relay-server/`](relay-server/README.md). Its
`npm run test:reliability` runs the heartbeat and room-closing checks against real relays it
starts itself.
