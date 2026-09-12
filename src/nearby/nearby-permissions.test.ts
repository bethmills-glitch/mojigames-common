// ensureNearbyPermissions — the Android runtime-permission matrix.
//
// This set is API-level dependent, invisible on web and in tests unless asserted, and
// wrong in a way that fails SILENTLY: Nearby Connections "will refuse to allow your app
// to start advertising or discovering" if any required permission is missing, so a bad
// matrix looks like "nobody can find the host" rather than like an error. An earlier
// version skipped ACCESS_FINE_LOCATION on API 31 and broke in-person play on every
// Android 12.0 phone with no visible symptom. These cases pin the matrix to Google's
// reference manifest: https://developers.google.com/nearby/connections/android/get-started

// The factory must be self-contained: babel-jest hoists `jest.mock` above the imports, so
// anything it closes over is still uninitialized when the factory first runs.
jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 33 },
  PermissionsAndroid: {
    PERMISSIONS: {
      ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION',
      BLUETOOTH_ADVERTISE: 'android.permission.BLUETOOTH_ADVERTISE',
      BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
      BLUETOOTH_SCAN: 'android.permission.BLUETOOTH_SCAN',
      NEARBY_WIFI_DEVICES: 'android.permission.NEARBY_WIFI_DEVICES',
    },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
    requestMultiple: jest.fn(),
  },
}));

import { PermissionsAndroid, Platform } from 'react-native';

import { ensureNearbyPermissions } from './nearby-lib';

const PERMISSIONS = PermissionsAndroid.PERMISSIONS as unknown as Record<string, string>;
const requestMultiple = PermissionsAndroid.requestMultiple as unknown as jest.Mock;

/** Pretend the device runs `api`, and that the user grants everything asked for. */
function onApi(api: number): void {
  (Platform as { OS: string }).OS = 'android';
  (Platform as { Version: number }).Version = api;
  requestMultiple.mockImplementation((perms: string[]) =>
    Promise.resolve(Object.fromEntries(perms.map((p) => [p, 'granted']))),
  );
}

/** The permissions the last call asked the OS for. */
function asked(): string[] {
  return requestMultiple.mock.calls[0][0];
}

beforeEach(() => {
  requestMultiple.mockReset();
});

describe('ensureNearbyPermissions', () => {
  it('asks only for location on Android 11 and older', async () => {
    onApi(30);
    await expect(ensureNearbyPermissions()).resolves.toBe(true);
    expect(asked()).toEqual([PERMISSIONS.ACCESS_FINE_LOCATION]);
  });

  it('still asks for location on Android 12.0, where Nearby requires it', async () => {
    // Google's manifest bounds ACCESS_FINE_LOCATION as minSdk 29 / maxSdk 31. Dropping it
    // at 31 is the regression this file exists to catch.
    onApi(31);
    await expect(ensureNearbyPermissions()).resolves.toBe(true);
    expect(asked()).toContain(PERMISSIONS.ACCESS_FINE_LOCATION);
    expect(asked()).toContain(PERMISSIONS.BLUETOOTH_SCAN);
    expect(asked()).not.toContain(PERMISSIONS.NEARBY_WIFI_DEVICES);
  });

  it('drops location from Android 12L, where Bluetooth alone carries discovery', async () => {
    onApi(32);
    await expect(ensureNearbyPermissions()).resolves.toBe(true);
    expect(asked()).toEqual([
      PERMISSIONS.BLUETOOTH_ADVERTISE,
      PERMISSIONS.BLUETOOTH_CONNECT,
      PERMISSIONS.BLUETOOTH_SCAN,
    ]);
  });

  it('adds the Wi-Fi permission on Android 13+, and never asks for location', async () => {
    onApi(34);
    await expect(ensureNearbyPermissions()).resolves.toBe(true);
    expect(asked()).toEqual([
      PERMISSIONS.BLUETOOTH_ADVERTISE,
      PERMISSIONS.BLUETOOTH_CONNECT,
      PERMISSIONS.BLUETOOTH_SCAN,
      PERMISSIONS.NEARBY_WIFI_DEVICES,
    ]);
  });

  it('reports false when the user denies any one of them', async () => {
    onApi(34);
    requestMultiple.mockResolvedValue({
      [PERMISSIONS.BLUETOOTH_ADVERTISE]: 'granted',
      [PERMISSIONS.BLUETOOTH_CONNECT]: 'granted',
      [PERMISSIONS.BLUETOOTH_SCAN]: 'denied',
      [PERMISSIONS.NEARBY_WIFI_DEVICES]: 'granted',
    });
    await expect(ensureNearbyPermissions()).resolves.toBe(false);
  });

  it('asks for nothing on iOS — the OS prompts from the Info.plist strings', async () => {
    onApi(0);
    (Platform as { OS: string }).OS = 'ios';
    await expect(ensureNearbyPermissions()).resolves.toBe(true);
    expect(requestMultiple).not.toHaveBeenCalled();
  });
});
