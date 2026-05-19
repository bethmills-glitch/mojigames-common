// mojigames-common/storage — a namespaced key/value store with a versioned wipe.
//
// `createStorage({ namespace, wipeVersion, wipeKeys, wipePrefixes })` returns a small
// async key/value API over @react-native-async-storage/async-storage (iOS, Android, web).
// Each game passes its own `namespace`, so two games on one device never collide.
// `checkAndApplyWipe()` clears all data when `wipeVersion` changes — run it once at
// startup, before loading anything else.

export { createStorage } from './storage';
export type { Storage, StorageConfig } from './storage';
