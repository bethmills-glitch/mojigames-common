// useMultiplayer — the React binding for a multiplayer `Transport`.
//
// Wraps any `Transport` (this package's `OnlineTransport`, the `nearby` transport, or any
// other implementation) in React state: a connection `status`, the room `code`, the
// opponent's peer id, and host/join/send/leave actions. The hook is transport-agnostic —
// the game supplies a `createTransport` factory, so the hook never imports a concrete
// transport and a game bundles only the transports it actually uses.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Transport, TransportEvent } from './types';

/**
 * The connection lifecycle:
 *   idle       — nothing started yet
 *   connecting — opening the connection; hosting or joining is in flight
 *   waiting    — hosted, room created, waiting for the opponent to join (host only)
 *   connected  — both players are in the room
 *   error      — failed, or the opponent left (see `error`)
 *   closed     — the session was ended
 */
export type MultiplayerStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'connected'
  | 'error'
  | 'closed';

export interface Multiplayer {
  status: MultiplayerStatus;
  /** The room share code (host: minted; guest: the one entered). Null until known. */
  code: string | null;
  /** This device's peer id within the room. */
  selfId: string | null;
  /** The opponent's peer id, or null when no opponent is present. */
  opponentId: string | null;
  /** A short reason when `status === 'error'` (e.g. `no-room`, `room-full`, `opponent-left`). */
  error: string | null;
  /** Create a room — `status` goes connecting → waiting → connected. */
  host: () => void;
  /** Join a room by code — `status` goes connecting → connected (or error). */
  join: (code: string) => void;
  /** Send a message to the opponent. A no-op before the room is connected. */
  send: (data: unknown) => void;
  /** End the session and tear the connection down. */
  leave: () => void;
}

interface UseMultiplayerOptions {
  /**
   * Builds the transport for one session. Called once, lazily, on the first
   * `host()`/`join()`; `leave()` discards the transport so the next call builds a fresh
   * one — which lets the game switch transport (online vs nearby) between sessions.
   */
  createTransport: () => Transport;
  /** Called for every message received from the opponent. */
  onMessage?: (from: string, data: unknown) => void;
}

/**
 * Drive one multiplayer session for a screen. Call it once; render off `status`, `code`,
 * `opponentId`; drive the room with `host` / `join`; exchange game messages with `send` +
 * the `onMessage` option.
 */
export function useMultiplayer({
  createTransport,
  onMessage,
}: UseMultiplayerOptions): Multiplayer {
  const [status, setStatus] = useState<MultiplayerStatus>('idle');
  const [code, setCode] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One transport per session, created lazily on the first host()/join().
  const transportRef = useRef<Transport | null>(null);
  // Latest createTransport / onMessage, kept in refs so they never have to be effect or
  // callback dependencies — the caller can pass inline functions without causing churn.
  const createTransportRef = useRef(createTransport);
  createTransportRef.current = createTransport;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const handleEvent = useCallback((event: TransportEvent) => {
    switch (event.type) {
      case 'hosting':
        setCode(event.code);
        setSelfId(event.selfId);
        setStatus('waiting');
        break;
      case 'joined':
        setCode(event.code);
        setSelfId(event.selfId);
        // The host is already in the room, so joining means we are connected.
        setOpponentId(event.peers[0] ?? null);
        setStatus(event.peers.length > 0 ? 'connected' : 'waiting');
        break;
      case 'peer-join':
        setOpponentId(event.peerId);
        setStatus('connected');
        break;
      case 'peer-leave':
        setOpponentId(null);
        setError('opponent-left');
        setStatus('error');
        break;
      case 'message':
        onMessageRef.current?.(event.from, event.data);
        break;
      case 'error':
        setError(event.reason);
        setStatus('error');
        break;
      case 'closed':
        // Keep an 'error' status (more informative) rather than overwriting it.
        setStatus((s) => (s === 'error' ? s : 'closed'));
        break;
    }
  }, []);

  /** Lazily build the transport (via the game's factory) and subscribe to it — once. */
  const ensureTransport = useCallback((): Transport => {
    if (!transportRef.current) {
      const created = createTransportRef.current();
      created.subscribe(handleEvent);
      transportRef.current = created;
    }
    return transportRef.current;
  }, [handleEvent]);

  const host = useCallback(() => {
    setError(null);
    setStatus('connecting');
    ensureTransport().host({ size: 2 });
  }, [ensureTransport]);

  const join = useCallback(
    (joinCode: string) => {
      setError(null);
      setStatus('connecting');
      ensureTransport().join(joinCode);
    },
    [ensureTransport],
  );

  const send = useCallback((data: unknown) => {
    transportRef.current?.send(data);
  }, []);

  const leave = useCallback(() => {
    transportRef.current?.close();
    transportRef.current = null;
    setStatus('closed');
  }, []);

  // Tear the transport down when the screen unmounts.
  useEffect(() => {
    return () => {
      transportRef.current?.close();
      transportRef.current = null;
    };
  }, []);

  return { status, code, selfId, opponentId, error, host, join, send, leave };
}
