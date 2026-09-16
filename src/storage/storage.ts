// mojigames-common/storage — a namespaced key/value store with a versioned wipe.
//
// Runs on @react-native-async-storage/async-storage, which works on iOS, Android AND web
// (on web it falls back to localStorage). `createStorage()` is a factory so every game
// gets its own key namespace — two games on one device never collide.
//
// Every operation is best-effort: a storage error is swallowed and treated as "absent"
// rather than thrown, so a full disk or private-mode quirk can never crash the game. The ONE
// exception is the versioned wipe — see checkAndApplyWipe, where "I could not read it" must never
// be mistaken for "there is no marker", because that answer erases everything the player has.

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Configuration for one game's storage — see `createStorage`. */
export interface StorageConfig {
  /** Key namespace. Every key is stored as `<namespace>:<key>`; pick a unique one per game. */
  namespace: string;
  /**
   * Bump this string (e.g. +1) whenever the SHAPE of stored data changes. At startup
   * `checkAndApplyWipe()` compares it to a stored marker; a mismatch wipes all data so a
   * player never loads a stale, incompatible blob.
   */
  wipeVersion: string;
  /** The keys a wipe / reset clears. (The internal `wipeApplied` marker always survives.) */
  wipeKeys: string[];
  /**
   * Optional un-prefixed key-prefixes a wipe also clears — e.g. a legacy `savedGame:`
   * family. Every stored key starting with one of these is removed.
   */
  wipePrefixes?: string[];
}

/** The async key/value API returned by `createStorage`. */
export interface Storage {
  /** Read a raw string value. Null if the key is absent or on any storage error. */
  getString(key: string): Promise<string | null>;
  /** Write a raw string value. Best-effort — storage errors are swallowed. */
  setString(key: string, value: string): Promise<void>;
  /** Delete a key. Best-effort. */
  remove(key: string): Promise<void>;
  /** Read + JSON-parse a value. Null when absent OR the stored text is not valid JSON. */
  getJSON<T>(key: string): Promise<T | null>;
  /** JSON-stringify and write a value. Best-effort. */
  setJSON(key: string, value: unknown): Promise<void>;
  /** List stored keys (un-prefixed), optionally filtered by an un-prefixed prefix. */
  listKeys(prefix?: string): Promise<string[]>;
  /** Clear every configured `wipeKey` + `wipePrefix` match. Keeps the wipe marker. */
  wipeAllData(): Promise<void>;
  /**
   * The one-time versioned wipe — run once at startup before loading anything else. Wipes
   * all data and stamps the marker when `wipeVersion` does not match the stored marker;
   * returns true if a wipe ran (the caller should then start from defaults).
   */
  checkAndApplyWipe(): Promise<boolean>;
}

/** The wipe-version marker's key — kept stable, never cleared by a wipe. */
const WIPE_APPLIED_KEY = 'wipeApplied';

/**
 * Build a storage instance for one game. Pass a unique `namespace` (e.g. the game's slug)
 * plus the versioned-wipe configuration.
 */
export function createStorage(config: StorageConfig): Storage {
  const NS = `${config.namespace}:`;
  /** Prefix a bare key with the namespace. */
  const ns = (key: string): string => NS + key;

  const getString = async (key: string): Promise<string | null> => {
    try {
      return await AsyncStorage.getItem(ns(key));
    } catch {
      return null;
    }
  };

  const setString = async (key: string, value: string): Promise<void> => {
    try {
      await AsyncStorage.setItem(ns(key), value);
    } catch {
      /* best-effort */
    }
  };

  const remove = async (key: string): Promise<void> => {
    try {
      await AsyncStorage.removeItem(ns(key));
    } catch {
      /* best-effort */
    }
  };

  const getJSON = async <T>(key: string): Promise<T | null> => {
    const raw = await getString(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const setJSON = async (key: string, value: unknown): Promise<void> => {
    await setString(key, JSON.stringify(value));
  };

  const listKeys = async (prefix = ''): Promise<string[]> => {
    try {
      const all = await AsyncStorage.getAllKeys();
      const full = ns(prefix);
      return all.filter((k) => k.startsWith(full)).map((k) => k.slice(NS.length));
    } catch {
      return [];
    }
  };

  const wipeAllData = async (): Promise<void> => {
    // Expand the configured prefixes into the concrete keys currently stored under them.
    const prefixKeys: string[] = [];
    for (const prefix of config.wipePrefixes ?? []) {
      prefixKeys.push(...(await listKeys(prefix)));
    }
    // The wipe marker must survive a wipe, so it can never be in the cleared set.
    const keys = [...config.wipeKeys, ...prefixKeys].filter((k) => k !== WIPE_APPLIED_KEY);
    try {
      await AsyncStorage.multiRemove(keys.map(ns));
    } catch {
      // The batch delete failed — fall back to best-effort individual deletes so one bad
      // key cannot abort the rest of the wipe.
      await Promise.allSettled(keys.map((k) => remove(k)));
    }
  };

  const checkAndApplyWipe = async (): Promise<boolean> => {
    let stored: string | null;
    try {
      // Deliberately NOT getString(): that maps a read FAILURE to null, and null here means "no
      // marker yet", which is what triggers the wipe. So a locked SQLite file or a moment of disk
      // pressure during startup would delete every profile, stat, streak and daily result on the
      // device — silently, and looking like a fresh install afterwards (2026-09-16 audit).
      // Skipping a wipe is harmless: it simply runs on the next launch. Losing the player's data
      // is not recoverable, so an unreadable marker must never be treated as a missing one.
      stored = await AsyncStorage.getItem(ns(WIPE_APPLIED_KEY));
    } catch {
      return false;
    }
    if (stored === config.wipeVersion) return false;
    await wipeAllData();
    await setString(WIPE_APPLIED_KEY, config.wipeVersion);
    return true;
  };

  return {
    getString,
    setString,
    remove,
    getJSON,
    setJSON,
    listKeys,
    wipeAllData,
    checkAndApplyWipe,
  };
}
