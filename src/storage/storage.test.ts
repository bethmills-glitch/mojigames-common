// createStorage tests — the namespaced key/value store.
//
// AsyncStorage is swapped for its official in-memory mock so the suite runs with no native
// runtime; AsyncStorage.clear() between tests keeps them isolated.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';

import { createStorage } from './storage';

// A storage instance with a test config — exercises the namespace, wipe keys + prefixes.
const storage = createStorage({
  namespace: 'demo',
  wipeVersion: '7',
  wipeKeys: ['stats', 'profiles', 'lastMode'],
  wipePrefixes: ['savedGame:'],
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('the namespace prefix', () => {
  it('stores every value under the <namespace>: prefix', async () => {
    await storage.setString('stats', 'hello');
    expect(await AsyncStorage.getItem('demo:stats')).toBe('hello');
    // the bare, un-prefixed key must not exist
    expect(await AsyncStorage.getItem('stats')).toBeNull();
  });
});

describe('getString / setString / remove', () => {
  it('round-trips a string value', async () => {
    await storage.setString('currentPlayer', 'Beth');
    expect(await storage.getString('currentPlayer')).toBe('Beth');
  });

  it('returns null for an absent key', async () => {
    expect(await storage.getString('neverWritten')).toBeNull();
  });

  it('overwrites an existing value', async () => {
    await storage.setString('lastMode', 'songs');
    await storage.setString('lastMode', 'movies');
    expect(await storage.getString('lastMode')).toBe('movies');
  });

  it('remove deletes a key', async () => {
    await storage.setString('lastMode', 'songs');
    await storage.remove('lastMode');
    expect(await storage.getString('lastMode')).toBeNull();
  });
});

describe('getJSON / setJSON', () => {
  it('round-trips an object', async () => {
    const profiles = { Beth: { score: 1200, gamesPlayed: 9 } };
    await storage.setJSON('profiles', profiles);
    expect(await storage.getJSON('profiles')).toEqual(profiles);
  });

  it('round-trips an array', async () => {
    await storage.setJSON('discovered', ['a', 'b', 'c']);
    expect(await storage.getJSON<string[]>('discovered')).toEqual(['a', 'b', 'c']);
  });

  it('returns null for an absent key', async () => {
    expect(await storage.getJSON('neverWritten')).toBeNull();
  });

  it('returns null for malformed JSON instead of throwing', async () => {
    await storage.setString('stats', '{not valid json');
    expect(await storage.getJSON('stats')).toBeNull();
  });
});

describe('listKeys', () => {
  it('returns stored keys without the namespace prefix', async () => {
    await storage.setString('stats', '1');
    await storage.setString('profiles', '2');
    expect((await storage.listKeys()).sort()).toEqual(['profiles', 'stats']);
  });

  it('filters by an un-prefixed prefix', async () => {
    await storage.setString('savedGame:1', 'x');
    await storage.setString('savedGame:2', 'y');
    await storage.setString('stats', 'z');
    expect((await storage.listKeys('savedGame:')).sort()).toEqual([
      'savedGame:1',
      'savedGame:2',
    ]);
  });

  it('only reports keys inside this namespace', async () => {
    await storage.setString('stats', '1');
    await AsyncStorage.setItem('other:thing', 'x'); // outside our namespace
    expect(await storage.listKeys()).toEqual(['stats']);
  });
});

describe('wipeAllData', () => {
  it('clears the configured wipeKeys and wipePrefixes', async () => {
    await storage.setString('stats', 'a');
    await storage.setString('profiles', 'b');
    await storage.setString('lastMode', 'c');
    await storage.setString('savedGame:abc', 'snapshot');

    await storage.wipeAllData();

    expect(await storage.getString('stats')).toBeNull();
    expect(await storage.getString('profiles')).toBeNull();
    expect(await storage.getString('lastMode')).toBeNull();
    expect(await storage.getString('savedGame:abc')).toBeNull();
  });

  it('keeps the wipeApplied marker so the one-time wipe does not re-fire', async () => {
    await storage.setString('wipeApplied', '7');
    await storage.setString('stats', 'data');

    await storage.wipeAllData();

    expect(await storage.getString('wipeApplied')).toBe('7');
    expect(await storage.getString('stats')).toBeNull();
  });
});

describe('checkAndApplyWipe', () => {
  it('wipes and stamps the marker on a fresh install (no marker yet)', async () => {
    const wiped = await storage.checkAndApplyWipe();
    expect(wiped).toBe(true);
    expect(await storage.getString('wipeApplied')).toBe('7');
  });

  it('does nothing when the marker already matches wipeVersion', async () => {
    await storage.setString('wipeApplied', '7');
    await storage.setJSON('stats', { score: 5000 });

    const wiped = await storage.checkAndApplyWipe();

    expect(wiped).toBe(false);
    expect(await storage.getJSON('stats')).toEqual({ score: 5000 });
  });

  it('does NOT wipe when the marker cannot be read', async () => {
    // A read ERROR is not "there is no marker". Treating it as one deleted every profile, stat,
    // streak and daily result on the device — silently, and looking like a fresh install
    // afterwards (2026-09-16 audit). Skipping a wipe is harmless: it runs again next launch.
    await storage.setString('wipeApplied', '6'); // stale on purpose: a wipe WOULD be due
    await storage.setJSON('stats', { score: 5000 });
    // Swapped by hand rather than with jest.spyOn: AsyncStorage here is the official in-memory
    // jest mock, and restoring a spy on it leaves a bare jest.fn() in place — which silently broke
    // every later read in this file.
    const realGetItem = AsyncStorage.getItem;
    let failedOnce = false;
    AsyncStorage.getItem = ((key: string) => {
      if (!failedOnce) {
        failedOnce = true;
        return Promise.reject(new Error('database is locked'));
      }
      return realGetItem(key);
    }) as typeof AsyncStorage.getItem;

    let wiped: boolean;
    try {
      wiped = await storage.checkAndApplyWipe();
    } finally {
      AsyncStorage.getItem = realGetItem;
    }

    expect(wiped).toBe(false);
    expect(await storage.getJSON('stats')).toEqual({ score: 5000 });
    expect(await storage.getString('wipeApplied')).toBe('6');
  });

  it('wipes stale data when the marker is from an older version', async () => {
    await storage.setString('wipeApplied', '6'); // a previous wipeVersion
    await storage.setJSON('stats', { score: 5000 });

    const wiped = await storage.checkAndApplyWipe();

    expect(wiped).toBe(true);
    expect(await storage.getString('stats')).toBeNull();
    expect(await storage.getString('wipeApplied')).toBe('7');
  });
});
