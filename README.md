# mojigames-common

Shared infrastructure for the **Mojigames** family of emoji-themed games — extracted from
Emoji Encore so every game starts with the same plumbing instead of rebuilding it.

## What's in here

| Import | What it gives you |
|---|---|
| `mojigames-common/multiplayer` | The `Transport` abstraction, `OnlineTransport` (a WebSocket relay client), the `useMultiplayer` React hook (1v1), and `useParty` (N-player, size-capped rooms: roster + host-authoritative start + live progress). |
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

## Developing

```bash
npm install
npm run typecheck   # tsc — type-check the source
npm test            # jest — run the unit tests
```

The relay server is its own mini-package — see [`relay-server/`](relay-server/README.md).
