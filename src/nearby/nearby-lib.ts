// nearby-lib — NATIVE. The guarded loader for `expo-nearby-connections`, plus the Android
// runtime-permission request. The web build resolves `nearby-lib.web.ts` instead, so this
// file — and its `require` of the native module — never enters the web bundle (the module
// has no web support and would otherwise crash the web build at load time).
//
// The guarded `require` mirrors lib/speech.ts and lib/audio.ts: in Expo Go the native
// module is absent, so `loadNearbyLib()` returns null and NearbyTransport degrades to
// "nearby unavailable" instead of the app crashing on launch.

import { PermissionsAndroid, Platform } from 'react-native';

import type { NearbyApi } from './nearby-transport';

let cached: NearbyApi | null = null;
let unavailable = false;

/**
 * Load `expo-nearby-connections` lazily. The `require` is wrapped so that a missing native
 * module — which happens in Expo Go rather than a custom dev build — leaves nearby play
 * simply unavailable instead of crashing the app. Returns null when it cannot be used.
 */
export function loadNearbyLib(): NearbyApi | null {
  if (cached) return cached;
  if (unavailable) return null;
  try {
    const mod = require('expo-nearby-connections') as NearbyApi;
    if (typeof mod.startAdvertise !== 'function') {
      unavailable = true;
      return null;
    }
    cached = mod;
    return mod;
  } catch {
    unavailable = true;
    return null;
  }
}

/** The union of Android permission strings — derived from RN's own constants. */
type AndroidPermission =
  (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS];

/**
 * Request the Android runtime permissions Nearby Connections needs. The matching manifest
 * entries are added by the `expo-nearby-connections` config plugin (see app.json); this
 * asks the user to grant the dangerous ones at runtime. On iOS the OS prompts for
 * local-network and Bluetooth access automatically on first use — driven by the Info.plist
 * usage strings the same plugin adds — so nothing is requested here for iOS.
 *
 * The exact set is API-level dependent and best-effort (it cannot be verified without
 * on-device testing); a wrong guess fails safe — `host()`/`join()` then report a
 * `permission-denied` error rather than crashing.
 */
export async function ensureNearbyPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const api = typeof Platform.Version === 'number' ? Platform.Version : 0;
  const P = PermissionsAndroid.PERMISSIONS;
  // Android 12+ (API 31): the granular Bluetooth permissions — and NO location. The consuming
  // apps' manifests declare BLUETOOTH_SCAN with usesPermissionFlags="neverForLocation" (we never
  // derive location from scans), which is what lets Nearby Connections run location-free on
  // modern Android. These are kids' apps: a location prompt they don't need is a Families-review
  // red flag and a scary parent moment. Wi-Fi-based discovery adds NEARBY_WIFI_DEVICES on 13+.
  // Android 11 and older gate BLE scanning behind (fine) location — unavoidable there.
  const wanted: AndroidPermission[] = [];
  if (api >= 31) {
    wanted.push(P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT, P.BLUETOOTH_SCAN);
    if (api >= 33) wanted.push(P.NEARBY_WIFI_DEVICES);
  } else {
    wanted.push(P.ACCESS_FINE_LOCATION);
  }
  try {
    const result = await PermissionsAndroid.requestMultiple(wanted);
    return wanted.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}
