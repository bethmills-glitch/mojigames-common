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
//   • a WAITLIST — a friend who arrives mid-game is told so (`party:closed`), stays connected,
//     and is dealt into the next game when the host calls `endMatch()` (see `benchRef`);
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
//
// Mixed builds share rooms (a friend on last month's app joins yours), so every protocol change
// here must keep working against the version before it: new fields are optional and ignored by
// older peers, and nothing new is ever REQUIRED of the other side.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Transport, TransportEvent } from './types';
import type { MultiplayerStatus } from './use-multiplayer';

/** The reserved roster id the host uses for itself (guests use their transport PeerId). */
export const HOST_ID = 'host';

/** Default room cap (host + 7 guests). Versus lobbies pass `maxPlayers: 2`. */
export const DEFAULT_MAX_PLAYERS = 8;

/** How long a guest waits for the host to answer its `party:hello` before saying so — see
 *  the `joined` handler. The answer is normally back in well under a second. */
const HOST_REPLY_TIMEOUT_MS = 5_000;

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
  // `waitlist: true` (added 2026-09-24): "if a game is running, keep me and seat me in the next
  // one" — this guest knows how to wait (see `benchRef`). Older guests don't send it, and are
  // turned away exactly as before: their screens can't recover from the error that explains it.
  | { t: 'party:hello'; id: string; name: string; meta: TMeta; waitlist?: boolean }
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
  /**
   * A short reason when `status === 'error'`:
   *   'no-room'           — no room has that code, or its host has gone (the room closed).
   *   'room-full'         — every seat is taken.
   *   'match-started'     — WAITING, not failed: a game was already running. This device stays
   *                         in the room and is dealt into the next game when the host returns
   *                         everyone to the lobby (`endMatch()`); status then goes back to
   *                         'connected' by itself. (A host on an older build seats it the moment
   *                         it is back in the lobby.) See `waitingForHost`.
   *   'host-unresponsive' — WAITING: joined, but the host hasn't answered for 5 s — their phone
   *                         may be asleep or the app in the background. Clears itself if the
   *                         host answers. See `waitingForHost`.
   *   'host-left'         — the host disconnected; this device has hung up too.
   *   'connection-lost'   — this device lost the connection (including 40 s of silence from the
   *                         relay).
   *   'timeout'           — the relay never answered the host/join request.
   *   …plus the nearby transport's own (`no-peers-found`, `permission-denied`, …).
   */
  error: string | null;
  /**
   * True while the error is one that can clear by itself — `match-started` or
   * `host-unresponsive`. Show "waiting…" with a Cancel (`leave()`), not a failure; when the
   * host answers, `status` returns to 'connected' and this goes false.
   */
  waitingForHost: boolean;
  isHost: boolean;
  /** This device's roster id (`'host'` or the transport PeerId). */
  selfId: string | null;
  /** The roster — host-authoritative; guests mirror the host's broadcasts. */
  members: PartyMember<TMeta>[];
  /** Host only: players who arrived mid-game and are waiting to be dealt into the next one —
   *  `endMatch()` seats them. Empty on a guest. */
  waitlist: PartyMember<TMeta>[];
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
   *  anyone re-joining — and the room re-opens to newcomers. Everyone on the `waitlist` is
   *  seated. No-op for a guest. */
  endMatch: () => void;
  /**
   * Host only: "Play again" straight from a match, without a stop in the lobby. Seats the
   * `waitlist`, then starts a new match whose payload `build` makes from the up-to-date roster —
   * so anyone who arrived mid-game is dealt in: `party.nextMatch((roster) => deal(roster))`.
   * Calling `start()` again from a match still works, but can't include them: the payload was
   * built before they were seated. No-op for a guest.
   */
  nextMatch: (build: (roster: PartyMember<TMeta>[]) => TStart) => void;

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
  /** How long a guest waits for the host to answer before `host-unresponsive` (default 5 s) —
   *  exposed for tests. */
  hostReplyTimeoutMs?: number;
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
  const [waitlist, setWaitlist] = useState<PartyMember<TMeta>[]>([]);
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
  // Host only: the WAITLIST — latecomers turned away mid-match (`party:closed` 'in-progress')
  // who said they can wait (`hello.waitlist`). They stay connected; `endMatch()` seats them, so
  // they are dealt into the next game. Keyed by transport id, like the map above, so a
  // `peer-leave` can take someone off it. (Not seated at `start()`: a game builds its payload —
  // who gets which cards — from `members` BEFORE calling start, so a player added inside start
  // would be in the match with no hand.) Before this, a turned-away latecomer stayed in the room
  // anyway, received the NEXT `party:start` without being dealt in, and sat watching a game that
  // wasn't theirs under a "Connection lost" overlay.
  const benchRef = useRef<Map<string, PartyMember<TMeta>>>(new Map());
  // Guest only: pending while our `party:hello` is unanswered — see the `joined` handler.
  const helloTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guest only: our hello, kept so a waitlisted guest can ask again (see `party:lobby`).
  const helloRef = useRef<ProtocolMessage<TStart, TProgress, TMeta> | null>(null);
  // Guest only: set while the current error is a WAITING one (see `Party.error`) — the host
  // seating us clears it, and the error with it. A ref, because the message handler that
  // notices must decide synchronously whether there is an error to clear.
  const waitingRef = useRef<'match-started' | 'host-unresponsive' | null>(null);
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

  const clearHelloTimer = useCallback(() => {
    if (helloTimerRef.current) {
      clearTimeout(helloTimerRef.current);
      helloTimerRef.current = null;
    }
  }, []);

  /** Hang up and forget the transport; a later `host()`/`join()` builds a fresh one. */
  const dropTransport = useCallback(() => {
    const transport = transportRef.current;
    transportRef.current = null;
    transport?.close();
  }, []);

  /**
   * Guest: does this host-sent list seat us? If so the host has answered us — and any WAITING
   * error is over: the room went from "a game is on, hang on" or "the host isn't answering" to
   * having a seat for us, so clear it and go back to 'connected'.
   */
  const seatedIn = useCallback(
    (list: PartyMember<TMeta>[]): boolean => {
      const me = selfIdRef.current;
      if (!me || !list.some((m) => m.id === me)) return false;
      clearHelloTimer();
      if (waitingRef.current) {
        waitingRef.current = null;
        setError(null);
        setStatus('connected');
      }
      return true;
    },
    [clearHelloTimer],
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
          if (cur.some((m) => m.id === msg.id)) {
            // A duplicate hello — already seated, so they evidently missed the answer. Say it
            // again: a guest now treats an unanswered hello as an unresponsive host.
            rawSend({ t: 'party:roster', members: cur } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
            return;
          }
          // Match already running, or the room is full → turn the latecomer away instead of
          // seating a ghost. The reply is broadcast (transports have no unicast) and matched by
          // `id` on the far side, so only this joiner reacts.
          if (startedRef.current || cur.length >= maxPlayers) {
            const inProgress = startedRef.current;
            rawSend({ t: 'party:closed', id: msg.id, reason: inProgress ? 'in-progress' : 'room-full' } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
            // …but a latecomer who can wait goes on the waitlist, to be seated at endMatch().
            if (inProgress && msg.waitlist === true) {
              benchRef.current.set(from, { id: msg.id, name: msg.name || 'Player', meta: msg.meta });
              setWaitlist([...benchRef.current.values()]);
            }
            return;
          }
          transportIdToRosterId.current.set(from, msg.id);
          setRoster([...cur, { id: msg.id, name: msg.name || 'Player', meta: msg.meta }]);
          break;
        }
        case 'party:roster':
          if (role === 'guest') {
            setMembers(msg.members);
            seatedIn(msg.members);
          }
          break;
        case 'party:start':
          if (role === 'guest') {
            // A match that doesn't list us isn't ours to play: the host turned us away (a game
            // was already running, or the room was full) and this is its NEXT game. Entering it
            // anyway is how a turned-away latecomer ended up watching a game with no cards under
            // a "Connection lost" overlay. Stay put — the waitlist seats us at the next lobby.
            if (!seatedIn(msg.members)) return;
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
            // Still waiting since a mid-game turn-away, and this lobby doesn't list us? A host on
            // this version would have seated us (we'd be in `members`); an older one doesn't
            // keep a waitlist — but the room is open again, so ask again: in the lobby it seats a
            // hello like any other.
            if (!seatedIn(msg.members) && waitingRef.current === 'match-started' && helloRef.current) {
              rawSend(helloRef.current);
            }
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
            clearHelloTimer();
            if (msg.reason === 'room-full') {
              // Turned away for good. Hang up, rather than sit in the room holding one of its
              // relay seats and hearing a game it isn't in.
              waitingRef.current = null;
              setError('room-full');
              setStatus('error');
              dropTransport();
            } else {
              // A game is running. Stay connected and wait: the host seats us when it returns
              // everyone to the lobby. The error is how today's screens already explain this;
              // `waitingForHost` lets a newer screen say "you're in the next game".
              waitingRef.current = 'match-started';
              setError('match-started');
              setStatus('error');
            }
          }
          break;
        case 'party:progress':
          setProgress((cur) => ({ ...cur, [msg.id]: msg.progress }));
          break;
        default:
          optsRef.current.onGameMessage?.(from, data);
      }
    },
    [maxPlayers, setRoster, rawSend, seatedIn, clearHelloTimer, dropTransport],
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
          benchRef.current.clear();
          setWaitlist([]);
          setMembers([seed]);
          setStatus('waiting');
          break;
        }
        case 'joined': {
          setCode(event.code);
          setSelfId(event.selfId);
          selfIdRef.current = event.selfId;
          hostPeerRef.current = event.peers[0] ?? null; // the room creator is listed first
          waitingRef.current = null;
          clearHelloTimer();
          if (event.peers.length === 0) {
            // Nobody is here, host included: the room outlived its host (relays from before
            // 2026-09-24 kept such rooms joinable). Nothing in it can ever start — say so now
            // instead of "0 in the room · waiting for the host" forever, and hang up so we don't
            // keep the dead room alive for the next person with the code.
            setError('no-room');
            setStatus('error');
            dropTransport();
            break;
          }
          setStatus('connected');
          const hello = { t: 'party:hello', id: event.selfId, name: optsRef.current.self.name, meta: optsRef.current.self.meta, waitlist: true } satisfies ProtocolMessage<TStart, TProgress, TMeta>;
          helloRef.current = hello;
          rawSend(hello);
          // A live host answers a hello at once: a roster that seats us, or a `party:closed`.
          // Silence means no working host behind this code — their phone is asleep, the app is
          // in the background, or (on an older relay) they left and only stranded guests remain.
          // Say so rather than wait forever; a late answer still seats us (see seatedIn).
          helloTimerRef.current = setTimeout(() => {
            helloTimerRef.current = null;
            if (roleRef.current !== 'guest') return;
            waitingRef.current = 'host-unresponsive';
            setError('host-unresponsive');
            setStatus('error');
          }, optsRef.current.hostReplyTimeoutMs ?? HOST_REPLY_TIMEOUT_MS);
          break;
        }
        case 'peer-join':
          // Host: wait for the guest's `hello` before adding them (it carries their name).
          // Guest: the roster arrives via the host's `party:roster` broadcast.
          if (roleRef.current === 'host') setStatus('connected');
          break;
        case 'peer-leave':
          if (roleRef.current === 'host') {
            // Someone waiting for the next game gave up — take them off the waitlist.
            if (benchRef.current.delete(event.peerId)) setWaitlist([...benchRef.current.values()]);
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
            clearHelloTimer();
            waitingRef.current = null;
            setError('host-left');
            setStatus('error');
            // And hang up. Every game is host-authoritative, so this room is finished — and a
            // guest lingering in it kept it alive on the relay: a friend arriving with the same
            // code was seated in it and waited forever, and "Try again" re-joined the same empty
            // room. (The relay now closes a room when its host leaves; this covers relays from
            // before that.) The match state stays, so a final scoreboard can still be shown.
            dropTransport();
          }
          break;
        case 'message':
          handleProtocol(event.from, event.data);
          break;
        case 'error':
          clearHelloTimer();
          waitingRef.current = null;
          setError(event.reason);
          setStatus('error');
          break;
        case 'closed':
          clearHelloTimer();
          waitingRef.current = null; // no connection, nothing left to wait for
          setStatus((s) => (s === 'error' ? s : 'closed'));
          break;
      }
    },
    [rawSend, setRoster, handleProtocol, clearHelloTimer, dropTransport],
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

  /**
   * Host: seat the waitlist — the next game is what they were promised — and return the new
   * roster (the same array when nobody was waiting). Arrival order, while seats last: the relay's
   * own cap makes running out all but impossible (the waiting hold relay seats too), but if it
   * happens they're told the room is full rather than left waiting.
   */
  const seatWaitlist = useCallback((): PartyMember<TMeta>[] => {
    let live = rosterRef.current;
    for (const [transportId, member] of benchRef.current) {
      if (live.some((m) => m.id === member.id)) continue;
      if (live.length >= maxPlayers) {
        rawSend({ t: 'party:closed', id: member.id, reason: 'room-full' } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
        continue;
      }
      transportIdToRosterId.current.set(transportId, member.id);
      live = [...live, member];
    }
    benchRef.current.clear();
    setWaitlist([]);
    rosterRef.current = live;
    return live;
  }, [rawSend, maxPlayers]);

  // The counterpart to `start()`: everything start froze is released here — the seal on new
  // joiners, the match payload, and last game's scores (leaving those behind would open the next
  // game's leaderboard with stale numbers). The transport, the share code and the roster are
  // deliberately untouched. Guests follow via `party:lobby`; the LIVE roster rides along with it
  // because `party:start` overwrote each guest's `members` with the frozen copy. The waitlist is
  // seated BEFORE `party:lobby` goes out, so it lists them: each sees itself there, and its
  // "game in progress" wait ends by itself.
  const endMatch = useCallback(() => {
    if (roleRef.current !== 'host') return;
    startedRef.current = false;
    const live = seatWaitlist();
    rawSend({ t: 'party:lobby', members: live } satisfies ProtocolMessage<TStart, TProgress, TMeta>);
    setMembers(live);
    setMatch(null);
    setPhase('lobby');
    setProgress({});
  }, [rawSend, seatWaitlist]);

  // "Play again" without the lobby — what Mojino's rematch buttons do by calling start() again.
  // The waitlist is seated first and the payload built from the result, so a game that deals
  // hands from the roster deals the newcomers one. Progress is left alone, exactly as a second
  // start() leaves it; a lobby round-trip (endMatch) is what resets it.
  const nextMatch = useCallback(
    (build: (roster: PartyMember<TMeta>[]) => TStart) => {
      if (roleRef.current !== 'host') return;
      const before = rosterRef.current;
      const live = seatWaitlist();
      if (live !== before) setRoster(live); // everyone's live roster gains the newcomers
      start(build(live));
    },
    [seatWaitlist, setRoster, start],
  );

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
    clearHelloTimer();
    transportRef.current?.close();
    transportRef.current = null;
    roleRef.current = null;
    rosterRef.current = [];
    hostPeerRef.current = null;
    selfIdRef.current = null;
    startedRef.current = false;
    waitingRef.current = null;
    helloRef.current = null;
    benchRef.current.clear();
    transportIdToRosterId.current.clear();
    setStatus('closed');
    setPhase('lobby');
    setMatch(null);
    setMembers([]);
    setWaitlist([]);
    setProgress({});
    // The session is over, and its share code with it. Keeping it meant a host who tapped "Try
    // again" after a drop saw — and could share — the dead room's code while the new room was
    // still being made.
    setCode(null);
    setSelfId(null);
  }, [clearHelloTimer]);

  useEffect(() => {
    return () => {
      clearHelloTimer();
      transportRef.current?.close();
      transportRef.current = null;
    };
  }, [clearHelloTimer]);

  const waitingForHost = status === 'error' && (error === 'match-started' || error === 'host-unresponsive');

  return { status, code, error, waitingForHost, isHost, selfId, members, waitlist, phase, host, join, leave, start, match, endMatch, nextMatch, reportProgress, progress, broadcast };
}

/** Return a copy of `obj` without `key` — used to drop a departed player's progress. */
function dropKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}
