// OnlineTransport — the `online` transport: a WebSocket client for the relay server (see
// the relay-server folder of this repo). It translates the relay's wire protocol into
// `TransportEvent`s and the `Transport` calls into relay messages.
//
// It depends on nothing but a WebSocket. `WebSocket` is a global in React Native and in
// browsers; for Node (tests) an implementation can be injected. The WebSocket surface is
// declared locally (`WebSocketLike`) so this file needs no DOM lib and no dependencies.

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
}

/** The OPEN ready-state value — identical (`1`) across every WebSocket implementation. */
const WS_OPEN = 1;

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
  private ws: WebSocketLike | null = null;
  private readonly listeners = new Set<TransportListener>();
  /** The host/join request to send once the socket opens (it is issued before connect). */
  private pendingIntent:
    | { kind: 'host'; size: number }
    | { kind: 'join'; code: string }
    | null = null;
  /** True once `close()` was called here — tells a clean shutdown from a dropped link. */
  private closedByUs = false;

  constructor(options: OnlineTransportOptions) {
    this.url = options.url;
    const Impl =
      options.WebSocketImpl ??
      (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Impl) {
      throw new Error('OnlineTransport: no WebSocket implementation available');
    }
    this.WebSocketImpl = Impl;
  }

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  host(options?: { size?: number }): void {
    this.pendingIntent = { kind: 'host', size: Math.max(2, options?.size ?? 2) };
    this.beginOrResend();
  }

  join(code: string): void {
    this.pendingIntent = { kind: 'join', code: code.toUpperCase().trim() };
    this.beginOrResend();
  }

  send(data: unknown): void {
    this.sendRaw({ type: 'msg', data });
  }

  close(): void {
    this.closedByUs = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* best-effort */
      }
      this.ws = null;
    }
    this.emit({ type: 'closed' });
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  private emit(event: TransportEvent): void {
    // Iterate a copy so a listener that unsubscribes mid-dispatch is safe.
    for (const listener of [...this.listeners]) listener(event);
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
    this.closedByUs = false;
    let ws: WebSocketLike;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch {
      this.emit({ type: 'error', reason: 'connect-failed' });
      return;
    }
    this.ws = ws;

    ws.onopen = () => this.sendIntent();
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onerror = () => {
      // A failed connection / dropped link surfaces via `onclose`; nothing to do here.
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.closedByUs) {
        this.emit({ type: 'error', reason: 'connection-lost' });
        this.emit({ type: 'closed' });
      }
    };
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
        this.emit({
          type: 'hosting',
          code: msg.code ?? '',
          selfId: msg.peerId ?? '',
        });
        break;
      case 'joined':
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
        this.emit({ type: 'error', reason: msg.reason ?? 'unknown' });
        break;
      // 'pong' and anything else — ignored.
    }
  }
}
