// nearby-lib — WEB. A browser has no Bluetooth / MultipeerConnectivity radio, so there is
// no nearby transport on web. The web build resolves this file in place of nearby-lib.ts,
// which also keeps `expo-nearby-connections` (a native-only module) out of the web bundle
// entirely. `loadNearbyLib()` always returns null → NearbyTransport reports
// `nearby-unavailable`, and the Versus screen offers online play only.

import type { NearbyApi } from './nearby-transport';

/** No nearby module on web — always null. */
export function loadNearbyLib(): NearbyApi | null {
  return null;
}

/** Never reached on web (the loader returns null first); present to mirror nearby-lib.ts. */
export function ensureNearbyPermissions(): Promise<boolean> {
  return Promise.resolve(false);
}
