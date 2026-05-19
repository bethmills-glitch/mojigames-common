// The multiplayer core — the transport abstraction.
//
// A `Transport` is a pluggable connection backend: it knows how to host or join a room,
// send messages to the room, and report room/peer/message events. The game layer talks
// only to this interface, so the same game code runs over any transport — the `online`
// relay transport or the `nearby` (in-person) transport, both shipped by mojigames-common.
//
// Everything here is framework-agnostic (no React, no React Native, no Expo) so the core
// stays reusable in any JavaScript project.

/** A connection's stable id within a room, assigned by the transport. */
export type PeerId = string;

/**
 * An event emitted by a transport. Exactly one of `hosting` / `joined` arrives first
 * (depending on whether this peer hosted or joined), then peer + message events flow,
 * and `closed` is always last.
 */
export type TransportEvent =
  /** This peer created a room — `code` is the share code to hand to the other player. */
  | { type: 'hosting'; code: string; selfId: PeerId }
  /** This peer joined a room — `peers` are the ids already present (the host). */
  | { type: 'joined'; code: string; selfId: PeerId; peers: PeerId[] }
  /** Another peer joined this room. */
  | { type: 'peer-join'; peerId: PeerId }
  /** Another peer left this room (disconnected or quit). */
  | { type: 'peer-leave'; peerId: PeerId }
  /** A message relayed from peer `from` — `data` is the game's own opaque payload. */
  | { type: 'message'; from: PeerId; data: unknown }
  /** Something went wrong — see `reason` (`no-room`, `room-full`, `connection-lost`, …). */
  | { type: 'error'; reason: string }
  /** The transport has fully shut down; no further events will be emitted. */
  | { type: 'closed' };

/** A listener for transport events. Returns nothing; register it via `Transport.subscribe`. */
export type TransportListener = (event: TransportEvent) => void;

/**
 * A pluggable connection backend. Implementations in mojigames-common: `OnlineTransport`
 * (WebSocket relay, this entry point) and `NearbyTransport` (in-person — see
 * `mojigames-common/nearby`). A game may also supply its own.
 *
 * Lifecycle: call `host()` or `join()` once, listen via `subscribe()`, `send()` while
 * connected, and `close()` to tear down.
 */
export interface Transport {
  /** Create a room. Emits `hosting` with the share code. `size` caps players (default 2). */
  host(options?: { size?: number }): void;
  /** Join a room by its share code. Emits `joined`, or `error` (`no-room` / `room-full`). */
  join(code: string): void;
  /** Send `data` to every other peer in the room. A no-op before the room is established. */
  send(data: unknown): void;
  /** Leave the room and tear down the connection. Emits `closed`. */
  close(): void;
  /** Subscribe to transport events. Returns an unsubscribe function. */
  subscribe(listener: TransportListener): () => void;
}
