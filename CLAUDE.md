# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

**mojigames-common** — shared infrastructure for the **Mojigames** family of emoji-themed
games. It was extracted from Emoji Encore (now **HitMoji**, the game in
`guessmoji-adults-v1`) so every game starts with the same plumbing instead of rebuilding
it. The other active consumer is **`mojiventure-v2`** (at `apps/mojiventure/`), which is in
fact where the `useParty` extraction was driven from. (`guessmoji-kids-v1` is an abandoned
prototype — not a consumer.)

Everything here is **game-agnostic** — networking, in-person transport, and storage only.
**Never add a game's catalog, scoring, screens, or branding here.** If a change would only
make sense for one game, it belongs in that game's repo, not this one.

`README.md` is the user-facing overview (import table, peer deps, wire protocol pointer);
this file is the Claude-facing orientation. They should agree — update both if the surface
changes.

## Three entry points + a server

| Import | What it gives you |
|---|---|
| `mojigames-common/multiplayer` | The `Transport` interface (`host`/`join`/`send`/`close`/`subscribe`), `OnlineTransport` (a WebSocket relay client), the `useMultiplayer` React hook (transport-agnostic — the game injects a `createTransport` factory), and `useParty` (N-player, size-capped rooms). |
| `mojigames-common/nearby` | `NearbyTransport` — in-person play between two phones in the same room (Bluetooth / local Wi-Fi), no internet. It implements `Transport`, so it drops straight into `useMultiplayer`. |
| `mojigames-common/storage` | `createStorage()` — a namespaced key/value store with a versioned wipe, over AsyncStorage. |
| `relay-server/` | A standalone, game-agnostic WebSocket relay (Node + `ws`). Its **own mini-package** with its own `package.json` and `README.md`. Deploy once; every game's online play shares it. |

Source layout (no build step — see below):

```
src/
  multiplayer/   index.ts · online-transport.ts · types.ts · use-multiplayer.ts · use-party.ts
  nearby/        index.ts · nearby-transport.ts · nearby-lib.ts · nearby-lib.web.ts
  storage/       index.ts · storage.ts
relay-server/    server.js · smoke-test.js · package.json · README.md
```

Tests sit beside their source as `*.test.ts` (`use-party.test.ts`, `nearby-transport.test.ts`,
`storage.test.ts`).

## Commands

```bash
npm install
npm run typecheck   # tsc — type-check the source
npm test            # jest (jest-expo preset) — unit tests

# relay server (its own package):
cd relay-server && npm install && node server.js   # listens on :8787; HTTP GET = health check
cd relay-server && node smoke-test.js              # exercises the full wire protocol
```

## No build step

The package **ships TypeScript source directly** (the `exports` map points at `.ts` files).
The consuming app's bundler (Metro) and type-checker handle it — there is nothing to compile
or publish here. Do not add a `dist/` build or a compile step without a deliberate reason.

## How games consume it

It's a **git dependency**, not an npm-registry package. In a game's `package.json`:

```json
"dependencies": { "mojigames-common": "github:bethmills-glitch/mojigames-common" }
```

**To ship a change:** commit + push here, then run `npm update mojigames-common` in the game.
There's no local symlink — the game pulls from GitHub. On EAS cloud builds the private repo is
cloned via a `MOJIGAMES_COMMON_TOKEN` secret + an `eas-build-pre-install` hook on the game side.

### Peer dependencies (the game provides these)

- `react`, `react-native` — always.
- `@react-native-async-storage/async-storage` — for `storage`.
- `expo-nearby-connections` — for `nearby`. **Optional** (`peerDependenciesMeta`): `nearby`
  degrades gracefully when it's absent, and it's native-only (no web transport). The
  platform-split `nearby-lib.ts` / `nearby-lib.web.ts` guards the `require` so the native
  module stays out of the web bundle.

## Critical rules

- **Stay game-agnostic.** No catalogs, scoring, or UI. This is the load-bearing constraint.
- **Storage namespace + versioned wipe** — `createStorage()` takes a namespace prefix and a
  wipe version; bumping the version wipes that namespace. Callers own their prefix (e.g. the
  adult app uses `emoji-encore:`). Don't hardcode a game's prefix here.
- **`Transport` is the seam.** Online and nearby both implement the same interface so
  `useMultiplayer` doesn't care which is in use. New transports implement `Transport`; don't
  branch on transport type inside the hook.
- **Relay protocol is a contract.** `server.js`, the `OnlineTransport` client, and
  `smoke-test.js` must stay in sync. Run the smoke test after touching the wire format.

## Git

On `main`. Consumed by `guessmoji-adults-v1` (HitMoji) and `mojiventure-v2` — both as git
dependencies. A benign package-lock rename (`emoji-encore-relay` → `mojigames-relay`) may
show as uncommitted.
