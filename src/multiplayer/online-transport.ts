// OnlineTransport — the `online` transport: a WebSocket client for the relay server (see
// the relay-server folder of this repo). It translates the relay's wire protocol into
// `TransportEvent`s and the `Transport` calls into relay messages.
//
// It depends on nothing but a WebSocket. `WebSocket` is a global in React Native and in
// browsers; for Node (tests) an implementation can be injected. The WebSocket surface is
// declared locally (`WebSocketLike`) so this file needs no DOM lib and no dependencies.
//
// ── The app-level heartbeat ──
// While the socket is open this transport pings the relay (`{type:'ping'}`) every 15 s, and
// treats 40 s with no message at all from the relay (its pongs count) as a dead link. Both
// halves exist because the live relay's own WebSocket-level ping never reaches a client — see
// the heartbeat notes in relay-server/server.js. The pings let the relay notice when THIS
// device stops (a sleeping phone, a backgrounded app) and tell the rest of the room; the
// silence check lets this device notice a link that died without ever reporting a close.

import type { Transport, TransportEvent, TransportListener } from './types';

/** The minimal WebSocket surface OnlineTransport uses — implemented by RN/browser/`ws`. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  /** 0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED — `1` is OPEN in every implementation. */
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** A WebSocket constructor — `globalThis.WebSocket`, or `ws` in Node. */
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface OnlineTransportOptions {
  /** Relay server URL — `ws://localhost:8787` in dev, `wss://…` once deployed. */
  url: string;
  /** WebSocket implementation. Defaults to the global one (present in RN and browsers). */
  WebSocketImpl?: WebSocketCtor;
  /** Override the host/join response timeout — exposed for tests. */
  connectTimeoutMs?: number;
  /** Override how often the heartbeat pings the relay (default 15 s) — exposed for tests. */
  pingIntervalMs?: number;
  /** Override how long the relay may stay silent before the link counts as dead (default
   *  40 s) — exposed for tests. */
  deadAfterMs?: number;
}

/** The OPEN ready-state value — identical (`1`) across every WebSocket implementation. */
const WS_OPEN = 1;

/** Heartbeat ping cadence. The relay drops a pinging client after 45 s of silence, so 15 s
 *  leaves room for two lost or late pings before a live client could be mistaken for a dead one. */
const DEFAULT_PING_INTERVAL_MS = 15_000;

/** Silence (no message at all — pongs count) after which the link is declared dead. Two and a
 *  half ping cycles: a live relay answers every ping, so this only trips on a link that is gone. */
const DEFAULT_DEAD_AFTER_MS = 40_000;

/** The heartbeat checks at least this often, so a dead link is reported within ~5 s of the limit. */
const MAX_HEARTBEAT_TICK_MS = 5_000;

/** How long to wait for the relay to answer a host/join request before giving up. Longer than
 *  NearbyTransport's timeout on purpose: the shared relay runs on Render's free tier, which
 *  sleeps after ~15 min idle and can take 30-60s to wake on the next request. 25s (this used to
 *  match Nearby's timeout) meant the very first host/join of a session reliably timed out before
 *  the relay finished waking — the connection then gets torn down and never recovers even though
 *  the relay comes up seconds later. 70s comfortably clears Render's documented worst case. */
const DEFAULT_CONNECT_TIMEOUT_MS = 70_000;

/** A parsed inbound relay message — only the fields this transport reads, all optional. */
interface RelayMessage {
  type?: string;
  code?: string;
  peerId?: string;
  peers?: string[];
  from?: string;
  data?: unknown;
  reason?: string;
}

export class OnlineTransport implements Transport {
  private readonly url: string;
  private readonly WebSocketImpl: WebSocketCtor;
  private readonly connectTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly deadAfterMs: number;
  /**
   * The socket this transport currently owns. Every socket handler checks it still IS this
   * socket before acting (see connect()), so a socket we have let go of — closed by `close()`,
   * the connect timeout or the heartbeat — can never report on the current session. That check
   * is also what tells a clean shutdown from a dropped link: a socket we let go of is no longer
   * `this.ws` by the time its close event arrives, so only a close we did NOT ask for is reported.
   */
  private ws: WebSocketLike | null = null;
  private readonly listeners = new Set<TransportListener>();
  /** The host/join request to send once the socket opens (it is issued before connect). */
  private pendingIntent:
    | { kind: 'host'; size: number }
    | { kind: 'join'; code: string }
    | null = null;
  /** Fires if the relay never answers a host/join request — see startConnectTimeout(). */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The heartbeat's interval while the socket is open — see startHeartbeat(). */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** When the relay last sent anything at all (a pong counts). */
  private lastHeardAt = 0;
  /** When the heartbeat last sent a ping. */
  private lastPingAt = 0;
  /** When the heartbeat last ran — a run far later than scheduled means we were suspended. */
  private lastTickAt = 0;

  constructor(options: OnlineTransportOptions) {
    this.url = options.url;
    const Impl =
      options.WebSocketImpl ??
      (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Impl) {
      throw new Error('OnlineTransport: no WebSocket implementation available');
    }
    this.WebSocketImpl = Impl;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.deadAfterMs = options.deadAfterMs ?? DEFAULT_DEAD_AFTER_MS;
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  host(options?: { size?: number }): void {
    this.pendingIntent = { kind: 'host', size: Math.max(2, options?.size ?? 2) };
    this.startConnectTimeout();
    this.beginOrResend();
  }

  join(code: string): void {
    this.pendingIntent = { kind: 'join', code: code.toUpperCase().trim() };
    this.startConnectTimeout();
    this.beginOrResend();
  }

  send(data: unknown): void {
    this.sendRaw({ type: 'msg', data });
  }

  close(): void {
    this.clearConnectTimeout();
    this.discardSocket();
    this.emit({ type: 'closed' });
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  private emit(event: TransportEvent): void {
    // Iterate a copy so a listener that unsubscribes mid-dispatch is safe.
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Give up if the relay never answers a host/join request (socket up or not). Mirrors
   *  NearbyTransport's guest-side scan timeout, but covers both roles: unlike a missing
   *  advertiser (which the OS-level discovery API itself can time out), a relay that opens
   *  the socket but never replies to `host`/`join` has nothing else to time it out here. */
  private startConnectTimeout(): void {
    this.clearConnectTimeout();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.emit({ type: 'error', reason: 'timeout' });
      // Drop the stalled socket so a fresh host()/join() call reconnects cleanly. Once it is
      // discarded its own close event is ignored, so it cannot ALSO report a connection-lost for
      // the very same stall this just reported more specifically — nor, arriving late, tear down
      // the retry's new socket (which it used to: it cleared the retry's connect timer, nulled its
      // socket and reported connection-lost on a link that was fine).
      this.discardSocket();
    }, this.connectTimeoutMs);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Send the pending host/join request over the (open) socket. */
  private sendIntent(): void {
    const intent = this.pendingIntent;
    if (intent?.kind === 'host') {
      this.sendRaw({ type: 'host', size: intent.size });
    } else if (intent?.kind === 'join') {
      this.sendRaw({ type: 'join', code: intent.code });
    }
  }

  /**
   * Act on the pending intent: open the socket if it is not up yet, or — when it is
   * already open (a retry after an error) — re-send the request straight away.
   */
  private beginOrResend(): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.sendIntent();
    } else {
      this.connect();
    }
  }

  private connect(): void {
    if (this.ws) return; // already connecting / connected
    let ws: WebSocketLike;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch {
      this.clearConnectTimeout();
      this.emit({ type: 'error', reason: 'connect-failed' });
      return;
    }
    this.ws = ws;

    // Each handler first checks this is still the transport's current socket — see `ws` above.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.sendIntent();
      this.startHeartbeat();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastHeardAt = Date.now(); // anything at all from the relay proves the link is alive
      this.handleMessage(event.data);
    };
    ws.onerror = () => {
      // A failed connection / dropped link surfaces via `onclose`; nothing to do here.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // a socket we already let go of — nothing to report
      this.clearConnectTimeout();
      this.stopHeartbeat();
      this.ws = null;
      this.emit({ type: 'error', reason: 'connection-lost' });
      this.emit({ type: 'closed' });
    };
  }

  /** Let go of the current socket: stop its heartbeat and close it without waiting for, or
   *  reporting, its close event (its handlers ignore it once it is no longer `this.ws`). */
  private discardSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.stopHeartbeat();
    if (!ws) return;
    try {
      ws.close();
    } catch {
      /* best-effort */
    }
  }

  // ── heartbeat ──────────────────────────────────────────────────────────────────────

  /** Start pinging the relay — called once the socket is open. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const now = Date.now();
    this.lastHeardAt = now;
    this.lastTickAt = now;
    this.lastPingAt = now;
    // The first ping goes out at once. It is what tells the relay this client heartbeats (the
    // relay only polices sockets that have pinged), so a phone that sleeps a second after
    // connecting is noticed just like one that sleeps an hour in.
    this.sendRaw({ type: 'ping' });
    const timer = setInterval(() => this.heartbeatTick(), this.heartbeatTickMs());
    // In Node (tests, scripts) don't let the heartbeat alone keep the process alive; the socket
    // does that. React Native's timers are plain numbers, so this is a no-op there.
    (timer as { unref?: () => void }).unref?.();
    this.heartbeatTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private heartbeatTickMs(): number {
    return Math.max(
      10,
      Math.min(MAX_HEARTBEAT_TICK_MS, this.pingIntervalMs, Math.floor(this.deadAfterMs / 4)),
    );
  }

  private heartbeatTick(): void {
    if (!this.ws) return;
    const now = Date.now();
    // A tick arriving far later than scheduled means this JS context was suspended: the app was
    // in the background or the phone asleep, and React Native runs no timers then (an overdue
    // interval fires once on resume). That silence was ours, not the relay's, so it must not
    // count against the link — pongs to pings we never sent cannot arrive. Restart the window
    // and ping at once; a link that really died will now fail to answer within deadAfterMs.
    if (now - this.lastTickAt > this.heartbeatTickMs() * 3) {
      this.lastHeardAt = now;
      this.lastPingAt = 0;
    }
    this.lastTickAt = now;
    if (now - this.lastHeardAt > this.deadAfterMs) {
      this.handleDeadLink();
      return;
    }
    if (now - this.lastPingAt >= this.pingIntervalMs) {
      this.lastPingAt = now;
      this.sendRaw({ type: 'ping' });
    }
  }

  /**
   * The relay has said nothing — not even a pong — for deadAfterMs. The socket may still claim
   * to be open: a half-open link (the phone changed networks, a NAT forgot us, the far end
   * vanished) never reports its own death, and a close handshake over it can take minutes. So
   * don't wait for onclose: let go of the socket and report the drop exactly as an unexpected
   * close does, so the app's existing connection-lost handling runs.
   */
  private handleDeadLink(): void {
    this.clearConnectTimeout();
    this.discardSocket();
    this.emit({ type: 'error', reason: 'connection-lost' });
    this.emit({ type: 'closed' });
  }

  private sendRaw(message: unknown): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(raw: unknown): void {
    let msg: RelayMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as RelayMessage;
    } catch {
      return; // ignore anything that is not JSON
    }
    switch (msg.type) {
      case 'hosted':
        this.clearConnectTimeout();
        this.emit({
          type: 'hosting',
          code: msg.code ?? '',
          selfId: msg.peerId ?? '',
        });
        break;
      case 'joined':
        this.clearConnectTimeout();
        this.emit({
          type: 'joined',
          code: msg.code ?? '',
          selfId: msg.peerId ?? '',
          peers: msg.peers ?? [],
        });
        break;
      case 'peer-join':
        this.emit({ type: 'peer-join', peerId: msg.peerId ?? '' });
        break;
      case 'peer-leave':
        this.emit({ type: 'peer-leave', peerId: msg.peerId ?? '' });
        break;
      case 'msg':
        this.emit({ type: 'message', from: msg.from ?? '', data: msg.data });
        break;
      case 'error':
        this.clearConnectTimeout();
        this.emit({ type: 'error', reason: msg.reason ?? 'unknown' });
        break;
      // 'pong' (the heartbeat's answer — onmessage already noted the relay is alive) and
      // anything else — ignored.
    }
  }
}
