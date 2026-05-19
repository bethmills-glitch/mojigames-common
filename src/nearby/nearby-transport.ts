// NearbyTransport — the `nearby` transport: in-person play between two phones in the same
// room, with no internet and no relay server. It implements the same `Transport` interface
// as `OnlineTransport` (mojigames-common/multiplayer), so `useMultiplayer` drives either
// one identically.
//
// It is built on `expo-nearby-connections`, which wraps Apple MultipeerConnectivity (iOS)
// and Google Nearby Connections (Android). That library is a native module, so:
//   • on a custom dev build it works;
//   • in Expo Go the native module is absent and `loadNearbyLib()` returns null;
//   • on web there is no nearby radio at all (nearby-lib.web.ts stubs the loader).
// In the latter two cases `host()`/`join()` emit `error: nearby-unavailable` and the game
// is unaffected — the Versus screen simply offers online play only.
//
// ── Mapping the discovery model onto host/join-by-code ──
// `expo-nearby-connections` is discovery-based (advertise / scan / connect), not
// code-based. To fit the `Transport` interface — and to keep the Versus lobby UI identical
// to online play — the host mints a short share code and *advertises under that code as
// its name*; the guest scans, and connects to the one advertiser whose name matches the
// code the player typed. The code also disambiguates two games running in the same room.

import type { Transport, TransportEvent, TransportListener } from '../multiplayer';

import { ensureNearbyPermissions, loadNearbyLib } from './nearby-lib';

// ── The expo-nearby-connections surface this transport uses ──────────────────────────────
// Declared locally rather than imported from the package, so a missing install can never
// break typechecking — the guarded `require` in nearby-lib.ts stays the only coupling to it.

/** A peer plus the name it advertised / discovered under (the share code, for our use). */
export interface NearbyPeer {
  peerId: string;
  name: string;
}
/** The unsubscribe handle every expo-nearby-connections event listener returns. */
export type NearbyUnsubscribe = () => void;

/** The slice of `expo-nearby-connections` NearbyTransport calls. */
export interface NearbyApi {
  startAdvertise(name: string, strategy?: number): Promise<string>;
  stopAdvertise(): Promise<void>;
  startDiscovery(name: string, strategy?: number): Promise<string>;
  stopDiscovery(): Promise<void>;
  requestConnection(advertisePeerId: string): Promise<void>;
  acceptConnection(targetPeerId: string): Promise<void>;
  rejectConnection(targetPeerId: string): Promise<void>;
  disconnect(targetPeerId?: string): Promise<void>;
  sendText(targetPeerId: string, text: string): Promise<void>;
  onPeerFound(callback: (data: NearbyPeer) => void): NearbyUnsubscribe;
  onInvitationReceived(callback: (data: NearbyPeer) => void): NearbyUnsubscribe;
  onConnected(callback: (data: NearbyPeer) => void): NearbyUnsubscribe;
  onDisconnected(callback: (data: { peerId: string }) => void): NearbyUnsubscribe;
  onTextReceived(callback: (data: { peerId: string; text: string }) => void): NearbyUnsubscribe;
}

// ── Code minting ─────────────────────────────────────────────────────────────────────────

/** Share-code length + alphabet — matches the relay server's `makeCode` so a code looks
 *  the same in either transport (no easily-confused glyphs: no I/L/O/0/1/B/8). */
const CODE_LENGTH = 4;
const CODE_ALPHABET = 'ACDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Mint a fresh share code for a nearby room. The relay dedups codes against live rooms
 * server-side; nearby has no server — but with 29⁴ ≈ 707k codes and only the handful of
 * devices in Bluetooth range, a collision between two simultaneous local games is
 * vanishingly unlikely, so `Math.random` is fine (no crypto-grade randomness needed).
 */
export function makeNearbyCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Whether in-person nearby play can run here: true only on a native build with the
 * `expo-nearby-connections` module present. False on web and in Expo Go. The Versus
 * screen calls this to decide whether to offer the "Same Room" option at all.
 */
export function isNearbyAvailable(): boolean {
  return loadNearbyLib() !== null;
}

// ── Tuning ───────────────────────────────────────────────────────────────────────────────

/** expo-nearby-connections `Strategy.P2P_STAR` — the documented default; fits the one-host
 *  + one-guest shape of a Versus match. Both peers MUST use the same strategy to find each
 *  other. (The enum value is inlined so the native module is not imported just for it.) */
const STRATEGY_P2P_STAR = 2;

/** The discovery name a guest scans under. The host never uses it (the player's real name
 *  is exchanged later in the Versus `hello` handshake), so a constant is fine. */
const DISCOVERY_NAME = 'Emoji Encore';

/** How long a guest scans for the host's code before giving up with `no-room`. */
const DEFAULT_CONNECT_TIMEOUT_MS = 25_000;

// ── Options ──────────────────────────────────────────────────────────────────────────────

export interface NearbyTransportOptions {
  /**
   * The `expo-nearby-connections` implementation. Omitted: the guarded loader is used
   * (the real module on a dev build, null otherwise). Pass an object to inject a fake in
   * tests; pass `null` to simulate the module being unavailable.
   */
  nearby?: NearbyApi | null;
  /** Override the guest's scan timeout — exposed for tests. */
  connectTimeoutMs?: number;
}

// ── The transport ────────────────────────────────────────────────────────────────────────

export class NearbyTransport implements Transport {
  private readonly nearby: NearbyApi | null;
  private readonly connectTimeoutMs: number;
  private readonly listeners = new Set<TransportListener>();
  /** Native event subscriptions, torn down on `close()`. */
  private readonly subs: NearbyUnsubscribe[] = [];

  private role: 'host' | 'guest' | null = null;
  /** The room code — the host mints it; the guest is the one the player typed. */
  private code: string | null = null;
  /** This device's peer id (from `startAdvertise` / `startDiscovery`). */
  private selfId: string | null = null;
  /** The connected opponent's peer id, once `onConnected` has fired. */
  private opponentId: string | null = null;
  /** The peer a connection is in flight to/from — guards the request→connected gap. */
  private pendingPeerId: string | null = null;
  /** The guest's scan timeout. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once `host()`/`join()` has run — each transport hosts or joins exactly once. */
  private started = false;
  private closed = false;

  constructor(options: NearbyTransportOptions = {}) {
    this.nearby = 'nearby' in options ? (options.nearby ?? null) : loadNearbyLib();
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  host(_options?: { size?: number }): void {
    // Versus is always two players, so `size` is ignored — there is one host and one guest.
    if (!this.begin('host')) return;
    this.code = makeNearbyCode();
    void this.runStart(async (nearby) => {
      const selfId = await nearby.startAdvertise(this.code as string, STRATEGY_P2P_STAR);
      if (this.closed) return;
      this.selfId = selfId;
      this.emit({ type: 'hosting', code: this.code as string, selfId });
    });
  }

  join(code: string): void {
    if (!this.begin('guest')) return;
    this.code = code.toUpperCase().trim();
    void this.runStart(async (nearby) => {
      const selfId = await nearby.startDiscovery(DISCOVERY_NAME, STRATEGY_P2P_STAR);
      if (this.closed) return;
      this.selfId = selfId;
      this.startConnectTimeout();
    });
  }

  send(data: unknown): void {
    if (this.closed || !this.opponentId || !this.nearby) return;
    // Nearby has no relay protocol layer — the JSON payload travels as the text frame.
    void this.nearby.sendText(this.opponentId, JSON.stringify(data)).catch(() => {
      /* a dropped frame surfaces as the opponent stalling, not as a thrown error */
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearConnectTimeout();
    for (const unsub of this.subs.splice(0)) {
      try {
        unsub();
      } catch {
        /* a failed unsubscribe must not break teardown */
      }
    }
    if (this.nearby) {
      // Best-effort teardown — each call is a harmless no-op if that mode was never active.
      void this.nearby.stopAdvertise().catch(() => {});
      void this.nearby.stopDiscovery().catch(() => {});
      void this.nearby.disconnect().catch(() => {});
    }
    this.emit({ type: 'closed' });
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────

  private emit(event: TransportEvent): void {
    // Iterate a copy so a listener that unsubscribes mid-dispatch is safe.
    for (const listener of [...this.listeners]) listener(event);
  }

  /**
   * Shared `host()`/`join()` pre-flight: reject a repeat call, fail fast when the native
   * module is unavailable, record the role, and wire up the native event listeners (before
   * any async work, so an early invitation/connection cannot be missed). Returns false when
   * the caller should stop.
   */
  private begin(role: 'host' | 'guest'): boolean {
    if (this.closed || this.started) return false;
    if (!this.nearby) {
      this.emit({ type: 'error', reason: 'nearby-unavailable' });
      return false;
    }
    this.started = true;
    this.role = role;
    this.setupListeners(this.nearby);
    return true;
  }

  /**
   * Request the OS permissions nearby needs, then run the advertise/discover `start`. A
   * permission denial or a rejected start surfaces as a transport `error`.
   */
  private async runStart(start: (nearby: NearbyApi) => Promise<void>): Promise<void> {
    const nearby = this.nearby;
    if (!nearby) return;
    let granted = false;
    try {
      granted = await ensureNearbyPermissions();
    } catch {
      granted = false;
    }
    if (this.closed) return;
    if (!granted) {
      this.emit({ type: 'error', reason: 'permission-denied' });
      return;
    }
    try {
      await start(nearby);
    } catch {
      if (!this.closed) this.emit({ type: 'error', reason: 'connect-failed' });
    }
  }

  private setupListeners(nearby: NearbyApi): void {
    this.subs.push(
      nearby.onPeerFound((peer) => this.handlePeerFound(peer)),
      nearby.onInvitationReceived((peer) => this.handleInvitation(peer)),
      nearby.onConnected((peer) => this.handleConnected(peer)),
      nearby.onDisconnected(({ peerId }) => this.handleDisconnected(peerId)),
      nearby.onTextReceived(({ peerId, text }) => this.handleText(peerId, text)),
    );
  }

  /** Guest: a nearby advertiser was discovered — connect if its name is the room code. */
  private handlePeerFound(peer: NearbyPeer): void {
    if (this.role !== 'guest' || this.closed) return;
    if (this.opponentId || this.pendingPeerId) return; // already connecting / connected
    if (peer.name.toUpperCase().trim() !== this.code) return; // a different room
    this.pendingPeerId = peer.peerId;
    void (this.nearby as NearbyApi).requestConnection(peer.peerId).catch(() => {
      this.pendingPeerId = null;
      if (!this.closed) this.emit({ type: 'error', reason: 'connect-failed' });
    });
  }

  /** Host: a guest asked to connect — accept the first, decline the rest (Versus is 1v1). */
  private handleInvitation(peer: NearbyPeer): void {
    if (this.role !== 'host' || this.closed) return;
    const nearby = this.nearby as NearbyApi;
    if (this.opponentId || this.pendingPeerId) {
      void nearby.rejectConnection(peer.peerId).catch(() => {});
      return;
    }
    this.pendingPeerId = peer.peerId;
    void nearby.acceptConnection(peer.peerId).catch(() => {
      this.pendingPeerId = null;
      if (!this.closed) this.emit({ type: 'error', reason: 'connect-failed' });
    });
  }

  /** Either role: a peer connection was established. */
  private handleConnected(peer: NearbyPeer): void {
    if (this.closed) return;
    if (this.opponentId) {
      // A surplus connection — Versus is 1v1, so drop anyone who is not our opponent.
      if (peer.peerId !== this.opponentId) {
        void (this.nearby as NearbyApi).disconnect(peer.peerId).catch(() => {});
      }
      return;
    }
    this.opponentId = peer.peerId;
    this.pendingPeerId = null;
    this.clearConnectTimeout();
    if (this.role === 'host') {
      // The room is full — stop advertising so no one else discovers it.
      void (this.nearby as NearbyApi).stopAdvertise().catch(() => {});
      this.emit({ type: 'peer-join', peerId: peer.peerId });
    } else {
      void (this.nearby as NearbyApi).stopDiscovery().catch(() => {});
      this.emit({
        type: 'joined',
        code: this.code ?? '',
        selfId: this.selfId ?? '',
        peers: [peer.peerId],
      });
    }
  }

  /** Either role: a peer disconnected — report it only for our actual opponent. */
  private handleDisconnected(peerId: string): void {
    if (this.closed || peerId !== this.opponentId) return;
    this.opponentId = null;
    this.emit({ type: 'peer-leave', peerId });
  }

  /** Either role: a text frame arrived from a peer — unwrap the JSON game payload. */
  private handleText(peerId: string, text: string): void {
    if (this.closed || peerId !== this.opponentId) return;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return; // ignore anything that is not JSON
    }
    this.emit({ type: 'message', from: peerId, data });
  }

  /** Guest: give up if no advertiser with the typed code is reached in time. */
  private startConnectTimeout(): void {
    this.clearConnectTimeout();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.closed || this.opponentId) return;
      // No advertiser with this code connected — a wrong code, or the host is not hosting.
      this.emit({ type: 'error', reason: 'no-room' });
      void this.nearby?.stopDiscovery().catch(() => {});
    }, this.connectTimeoutMs);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}
