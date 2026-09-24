// useParty — the React binding for an N-player "party" session over any `Transport`.
//
// Where `useMultiplayer` is a thin 1v1 wrapper (a single `opponentId`), `useParty` owns the
// reusable multi-player orchestration every party game needs and would otherwise rebuild:
//
//   • a host-authoritative ROSTER, maintained by a small wire protocol:
//       guest → host  `party:hello`   (I'm here — name + meta)
//       host  → all   `party:roster`  (the canonical player list, on every change)
//       host  → all   `party:leave`   (a player dropped)
//   • a host-authoritative MATCH START — the host calls `start(payload)`, the opaque payload
//     (e.g. the puzzle list + settings) is broadcast so every device plays the same set;
//   • a host-authoritative RETURN TO THE LOBBY — `endMatch()` broadcasts `party:lobby`, so ONE
//     room can host game after game (a "games night"): the share code, the socket and the
//     roster all survive, and the room re-opens to joiners. Without it a room was sealed for
//     life at the first Start, so every game meant a new room and a new code for everybody;
//   • live PROGRESS — `reportProgress(p)` broadcasts, `progress` collects everyone else's
//     latest (keyed by member id) for a live leaderboard;
//   • a `broadcast()` escape hatch + `onGameMessage` for anything game-specific (e.g. a
//     "first to solve wins the round" note) that isn't part of the party protocol.
//
// It drives the transport directly (not via `useMultiplayer`) so a guest leaving removes
// only that guest — it never errors the whole room, the way layering an N-player party over
// the 1v1 hook would. The game supplies a `createTransport` factory, so this hook stays
// transport-agnostic: the same party runs over `OnlineTransport` (relay) or the `nearby`
// transport with no game changes.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Transport, TransportEvent } from './types';
import type { MultiplayerStatus } from './use-multiplayer';

/** The reserved roster id the host uses for itself (guests use their transport PeerId). */
export const HOST_ID = 'host';

/** Default room cap (host + 7 guests). Versus lobbies pass `maxPlayers: 2`. */
export const DEFAULT_MAX_PLAYERS = 8;

/**
 * One player in the roster. `meta` is opaque game data (e.g. an avatar) the lobby renders;
 * it travels in the `hello`/`roster`/`start` messages so every device can show every player.
 */
export interface PartyMember<TMeta = unknown> {
  /** Stable per-session id — `'host'` for the host, the transport PeerId for a guest. */
  id: string;
  name: string;
  meta: TMeta;
}

/** lobby — gathering players; match — the host has started and everyone is playing. */
export type PartyPhase = 'lobby' | 'match';

/** The party protocol messages (lib-owned). Game messages travel via `broadcast`. */
type ProtocolMessage<TStart, TProgress, TMeta> =
  | { t: 'party:hello'; id: string; name: string; meta: TMeta }
  | { t: 'party:roster'; members: PartyMember<TMeta>[] }
  | { t: 'party:start'; payload: TStart; members: PartyMember<TMeta>[] }
  | { t: 'party:progress'; id: string; progress: TProgress }
  | { t: 'party:leave'; id: string }
  | { t: 'party:lobby'; members: PartyMember<TMeta>[] }
  | { t: 'party:closed'; id: string; reason: 'in-progress' | 'room-full' };

export interface Party<TStart = unknown, TProgress = unknown, TMeta = unknown> {
  status: MultiplayerStatus;
  /** The room share code (host: minted; guest: the one entered). Null until known, and null
   *  again once the session ends (`leave()`) or a new one begins (`host()`/`join()`). */
  code: string | null;
  /** A short reason when `status === 'error'` (`no-room`, `room-full`, `host-left`, …). */
  error: string | null;
  isHost: boolean;
  /** This device's roster id (`'host'` or the transport PeerId). */
  selfId: string | null;
  /** The roster — host-authoritative; guests mirror the host's broadcasts. */
  members: PartyMember<TMeta>[];
  phase: PartyPhase;

  /** Create a room (capped at `maxPlayers`). status → connecting → waiting → connected. */
  host: () => void;
  /** Join a room by code. status → connecting → connected (or error). */
  join: (code: string) => void;
  /** Leave and tear down the session. */
  leave: () => void;

  /** Host only: freeze the roster, broadcast `payload`, and enter the match. */
  start: (payload: TStart) => void;
  /** The started match (the opaque payload + the frozen roster), or null in the lobby. */
  match: { payload: TStart; members: PartyMember<TMeta>[] } | null;
  /** Host only: end the match and put everyone back in THIS same lobby. The room, its share
   *  code, the socket and the roster all survive, so a party can play game after game without
   *  anyone re-joining — and the room re-opens to newcomers. No-op for a guest. */
  endMatch: () => void;

  /** Broadcast this device's latest progress (for the live leaderboard). */
  reportProgress: (progress: TProgress) => void;
  /** Everyone else's latest progress, keyed by member id. */
  progress: Record<string, TProgress>;

  /** Send a raw game-specific message to the room (delivered to peers' `onGameMessage`). */
  broadcast: (data: unknown) => void;
}

export interface UsePartyOptions<TStart, TProgress, TMeta> {
  /** Builds the transport for one session (online vs nearby). See `useMultiplayer`. */
  createTransport: () => Transport;
  /** This device's lobby identity. */
  self: { name: string; meta: TMeta };
  /** Room cap (host + guests). Defaults to 8; Versus passes 2. */
  maxPlayers?: number;
  /** Messages that aren't part of the party protocol (the game's own — e.g. "round won"). */
  onGameMessage?: (from: string, data: unknown) => void;
}

/**
 * Drive one party session for a screen. Render the lobby off `status`/`code`/`members`,
 * start with `host`/`join` → `start(payload)`, then render the match off `match` +
 * `progress`, exchanging extra game events via `broadcast` + `onGameMessage`.
 */
export function useParty<TStart = unknown, TProgress = unknown, TMeta = unknown>(
  options: UsePartyOptions<TStart, TProgress, TMeta>,
): Party<TStart, TProgress, TMeta> {
  const [status, setStatus] = useState<MultiplayerStatus>('idle');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [members, setMembers] = useState<PartyMember<TMeta>[]>([]);
  const [phase, setPhase] = useState<PartyPhase>('lobby');
  const [match, setMatch] = useState<Party<TStart, TProgress, TMeta>['match']>(null);
  const [progress, setProgress] = useState<Record<string, TProgress>>({});

  const transportRef = useRef<Transport | null>(null);
  const roleRef = useRef<'host' | 'guest' | null>(null);
  // The host's authoritative roster (a ref so synchronous bursts of `hello`s don't race the
  // React state batch). Mirrored into `members` for rendering.
  const rosterRef = useRef<PartyMember<TMeta>[]>([]);
  // Guest only: the host's transport PeerId (the first peer in `joined`), so a `peer-leave`
  // for the host ends the session, while another guest leaving does not.
  const hostPeerRef = useRef<string | null>(null);
  // This device's roster id, mirrored into a ref so a transport callback can match a targeted
  // `party:closed` against it without re-subscribing.
  const selfIdRef = useRef<string | null>(null);
  // Host: true WHILE a match is running. A `party:hello` in that window is a latecomer the host
  // turns away — seating them would add a ghost that never receives the one-shot `party:start`
  // and hangs on the lobby forever. `endMatch()` clears it again: the seal lasts one match, not
  // the life of the room, which is what lets a persistent lobby re-admit a friend whose phone
  // dropped out mid-game.
  const startedRef = useRef(false);
  // Host only: maps a guest's TRANSPORT-level peer id (from `handleProtocol`'s `from`, i.e.
  // what a `peer-leave` will later report) → the roster id they registered under in their
  // `party:hello` (`msg.id`, self-reported). On `OnlineTransport` these are already the same
  // value — the relay mints one id per socket and uses it everywhere — so the fallback in
  // `peer-leave` below is a no-op there. On `NearbyTransport` they are DIFFERENT id
  // namespaces (each side's native stack — MultipeerConnectivity / Nearby Connections —
  // assigns its own local id for a connection, independently of the other side), so without
  // this mapping a `peer-leave` could never be correlated back to the roster entry it
  // should remove — the departed guest would linger as a ghost forever.
  const transportIdToRosterId = useRef<Map<string, string>>(new Map());
  const maxPlayers = options.maxPlayers ?? DEFAULT_MAX_PLAYERS;
  const optsRef = useRef(options);
  optsRef.current = options;

  const rawSend = useCallback((msg: unknown) => transportRef.current?.send(msg), []);

  /** Host: replace the roster, mirror to state, and broadcast it to every guest. */
  const setRoster = useCallback(
    (next: PartyMember<TMeta>[]) => {
      rosterRef.current = next;
      setMembers(next);
      rawSend({ t: 'party:roster', members: next } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
    },
    [rawSend],
  );

  const handleProtocol = useCallback(
    (from: string, data: unknown) => {
      const role = roleRef.current;
      const msg = data as ProtocolMessage<TStart, TProgress, TMeta> | null;
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
        optsRef.current.onGameMessage?.(from, data); // not ours → hand to the game
        return;
      }
      switch (msg.t) {
        case 'party:hello': {
          if (role !== 'host') return;
          const cur = rosterRef.current;
          if (cur.some((m) => m.id === msg.id)) return; // a duplicate hello — already seated
          // Match already running, or the room is full → turn the latecomer away instead of
          // seating a ghost. The reply is broadcast (transports have no unicast) and matched by
          // `id` on the far side, so only this joiner reacts.
          if (startedRef.current || cur.length >= maxPlayers) {
            rawSend({ t: 'party:closed', id: msg.id, reason: startedRef.current ? 'in-progress' : 'room-full' } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
            return;
          }
          transportIdToRosterId.current.set(from, msg.id);
          setRoster([...cur, { id: msg.id, name: msg.name || 'Player', meta: msg.meta }]);
          break;
        }
        case 'party:roster':
          if (role === 'guest') setMembers(msg.members);
          break;
        case 'party:start':
          if (role === 'guest') {
            setMatch({ payload: msg.payload, members: msg.members });
            setMembers(msg.members);
            setPhase('match');
          }
          break;
        case 'party:lobby':
          // The host finished that game and is back in the lobby choosing the next one. Mirror
          // it — the room, the share code and this socket all stay exactly as they are, which is
          // the whole point: nobody re-enters a code between games.
          if (role === 'guest') {
            setMembers(msg.members);
            setMatch(null);
            setPhase('lobby');
            setProgress({});
          }
          break;
        case 'party:leave':
          if (role === 'guest') {
            setProgress((cur) => dropKey(cur, msg.id));
          }
          break;
        case 'party:closed':
          // The host turned this device away (match already running, or room full). Only the
          // targeted joiner reacts — guests already in the room ignore it.
          if (role === 'guest' && msg.id === selfIdRef.current) {
            setError(msg.reason === 'room-full' ? 'room-full' : 'match-started');
            setStatus('error');
          }
          break;
        case 'party:progress':
          setProgress((cur) => ({ ...cur, [msg.id]: msg.progress }));
          break;
        default:
          optsRef.current.onGameMessage?.(from, data);
      }
    },
    [maxPlayers, setRoster, rawSend],
  );

  const handleEvent = useCallback(
    (event: TransportEvent) => {
      switch (event.type) {
        case 'hosting': {
          setCode(event.code);
          setSelfId(HOST_ID);
          selfIdRef.current = HOST_ID;
          const seed: PartyMember<TMeta> = { id: HOST_ID, name: optsRef.current.self.name, meta: optsRef.current.self.meta };
          rosterRef.current = [seed];
          setMembers([seed]);
          setStatus('waiting');
          break;
        }
        case 'joined':
          setCode(event.code);
          setSelfId(event.selfId);
          selfIdRef.current = event.selfId;
          hostPeerRef.current = event.peers[0] ?? null; // the room creator is listed first
          setStatus('connected');
          rawSend({ t: 'party:hello', id: event.selfId, name: optsRef.current.self.name, meta: optsRef.current.self.meta } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
          break;
        case 'peer-join':
          // Host: wait for the guest's `hello` before adding them (it carries their name).
          // Guest: the roster arrives via the host's `party:roster` broadcast.
          if (roleRef.current === 'host') setStatus('connected');
          break;
        case 'peer-leave':
          if (roleRef.current === 'host') {
            // Translate the transport's own peer id to the roster id that guest registered
            // under in `party:hello` (see transportIdToRosterId above) — on nearby these
            // differ; on online the fallback is a no-op since they already coincide.
            const rosterId = transportIdToRosterId.current.get(event.peerId) ?? event.peerId;
            transportIdToRosterId.current.delete(event.peerId);
            setRoster(rosterRef.current.filter((m) => m.id !== rosterId));
            rawSend({ t: 'party:leave', id: rosterId } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
            setProgress((cur) => dropKey(cur, rosterId));
          } else if (event.peerId === hostPeerRef.current) {
            // The host is gone. Flagging the error is not enough: without this the host
            // stays on the guest's roster, so their row sits frozen on the leaderboard,
            // any "has everyone finished?" check waits forever on a player who left, and
            // a host who quits while ahead can still be crowned the winner. Prune them the
            // same way the host prunes a departing guest just above.
            setMembers((cur) => cur.filter((m) => m.id !== HOST_ID));
            setProgress((cur) => dropKey(cur, HOST_ID));
            setError('host-left');
            setStatus('error');
          }
          break;
        case 'message':
          handleProtocol(event.from, event.data);
          break;
        case 'error':
          setError(event.reason);
          setStatus('error');
          break;
        case 'closed':
          setStatus((s) => (s === 'error' ? s : 'closed'));
          break;
      }
    },
    [rawSend, setRoster, handleProtocol],
  );

  const ensureTransport = useCallback((): Transport => {
    if (!transportRef.current) {
      const created = optsRef.current.createTransport();
      created.subscribe(handleEvent);
      transportRef.current = created;
    }
    return transportRef.current;
  }, [handleEvent]);

  const host = useCallback(() => {
    setError(null);
    setCode(null); // a new room gets a new code — never show the last one while this one opens
    roleRef.current = 'host';
    setIsHost(true);
    setStatus('connecting');
    ensureTransport().host({ size: maxPlayers });
  }, [ensureTransport, maxPlayers]);

  const join = useCallback(
    (joinCode: string) => {
      setError(null);
      setCode(null);
      roleRef.current = 'guest';
      setIsHost(false);
      setStatus('connecting');
      ensureTransport().join(joinCode);
    },
    [ensureTransport],
  );

  const start = useCallback(
    (payload: TStart) => {
      if (roleRef.current !== 'host') return;
      startedRef.current = true;
      const frozen = rosterRef.current;
      rawSend({ t: 'party:start', payload, members: frozen } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
      setMatch({ payload, members: frozen });
      setPhase('match');
    },
    [rawSend],
  );

  // The counterpart to `start()`: everything start froze is released here — the seal on new
  // joiners, the match payload, and last game's scores (leaving those behind would open the next
  // game's leaderboard with stale numbers). The transport, the share code and the roster are
  // deliberately untouched. Guests follow via `party:lobby`; the LIVE roster rides along with it
  // because `party:start` overwrote each guest's `members` with the frozen copy.
  const endMatch = useCallback(() => {
    if (roleRef.current !== 'host') return;
    startedRef.current = false;
    const live = rosterRef.current;
    rawSend({ t: 'party:lobby', members: live } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
    setMembers(live);
    setMatch(null);
    setPhase('lobby');
    setProgress({});
  }, [rawSend]);

  const reportProgress = useCallback(
    (p: TProgress) => {
      const id = roleRef.current === 'host' ? HOST_ID : selfId;
      if (!id) return;
      rawSend({ t: 'party:progress', id, progress: p } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
    },
    [rawSend, selfId],
  );

  const broadcast = useCallback((data: unknown) => rawSend(data), [rawSend]);

  const leave = useCallback(() => {
    transportRef.current?.close();
    transportRef.current = null;
    roleRef.current = null;
    rosterRef.current = [];
    hostPeerRef.current = null;
    selfIdRef.current = null;
    startedRef.current = false;
    transportIdToRosterId.current.clear();
    setStatus('closed');
    setPhase('lobby');
    setMatch(null);
    setMembers([]);
    setProgress({});
    // The session is over, and its share code with it. Keeping it meant a host who tapped "Try
    // again" after a drop saw — and could share — the dead room's code while the new room was
    // still being made.
    setCode(null);
    setSelfId(null);
  }, []);

  useEffect(() => {
    return () => {
      transportRef.current?.close();
      transportRef.current = null;
    };
  }, []);

  return { status, code, error, isHost, selfId, members, phase, host, join, leave, start, match, endMatch, reportProgress, progress, broadcast };
}

/** Return a copy of `obj` without `key` — used to drop a departed player's progress. */
function dropKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}
