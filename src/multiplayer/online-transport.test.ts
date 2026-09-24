// OnlineTransport tests — the `online` (WebSocket relay) transport. A fake WebSocket is
// injected via the constructor so the host/join/message/error flow, and the connect
// timeout, are exercised with no real network or relay server.

import { OnlineTransport, type WebSocketCtor, type WebSocketLike } from './online-transport';
import type { TransportEvent } from './types';

// ── A fake WebSocket ────────────────────────────────────────────────────────────────────

class FakeSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  closed = false;

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  /** Test-only: simulate the relay accepting the connection. */
  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  /** Test-only: simulate an inbound relay message. */
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** A WebSocketCtor that hands back (and records) every FakeSocket it creates. */
function fakeWebSocketCtor(): { Ctor: WebSocketCtor; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const Ctor = function (url: string) {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  } as unknown as WebSocketCtor;
  return { Ctor, sockets };
}

/** Subscribe and return the growing list of events the transport emits. */
function collect(transport: OnlineTransport): TransportEvent[] {
  const events: TransportEvent[] = [];
  transport.subscribe((event) => events.push(event));
  return events;
}

function eventsOfType<T extends TransportEvent['type']>(
  events: TransportEvent[],
  type: T,
): Extract<TransportEvent, { type: T }>[] {
  return events.filter((event): event is Extract<TransportEvent, { type: T }> => event.type === type);
}

// ── host / join / messaging ─────────────────────────────────────────────────────────────

describe('OnlineTransport — host', () => {
  it('opens the socket, sends {type:"host"}, and emits `hosting` once the relay answers', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);

    transport.host({ size: 4 });
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    // The request, then the heartbeat's first ping (see the heartbeat tests below).
    expect(sockets[0].sent).toEqual([{ type: 'host', size: 4 }, { type: 'ping' }]);

    sockets[0].receive({ type: 'hosted', code: 'ABCD', peerId: 'host' });
    const hosting = eventsOfType(events, 'hosting');
    expect(hosting).toEqual([{ type: 'hosting', code: 'ABCD', selfId: 'host' }]);
  });
});

describe('OnlineTransport — join', () => {
  it('sends {type:"join"} with an uppercased/trimmed code and emits `joined`', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);

    transport.join(' wxyz ');
    sockets[0].open();
    expect(sockets[0].sent).toEqual([{ type: 'join', code: 'WXYZ' }, { type: 'ping' }]);

    sockets[0].receive({ type: 'joined', code: 'WXYZ', peerId: 'guest-1', peers: ['host'] });
    expect(eventsOfType(events, 'joined')).toEqual([
      { type: 'joined', code: 'WXYZ', selfId: 'guest-1', peers: ['host'] },
    ]);
  });

  it('relays a server error (e.g. room-full) as an `error` event', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);

    transport.join('ABCD');
    sockets[0].open();
    sockets[0].receive({ type: 'error', reason: 'room-full' });

    expect(eventsOfType(events, 'error')).toEqual([{ type: 'error', reason: 'room-full' }]);
  });
});

describe('OnlineTransport — messaging', () => {
  it('serialises send() and parses a received frame into a `message` event', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);

    transport.host();
    sockets[0].open();
    sockets[0].receive({ type: 'hosted', code: 'ABCD', peerId: 'host' });

    transport.send({ hello: 'world' });
    expect(sockets[0].sent).toContainEqual({ type: 'msg', data: { hello: 'world' } });

    sockets[0].receive({ type: 'msg', from: 'guest-1', data: { hello: 'back' } });
    expect(eventsOfType(events, 'message')).toEqual([
      { type: 'message', from: 'guest-1', data: { hello: 'back' } },
    ]);
  });
});

describe('OnlineTransport — unexpected close', () => {
  it('emits connection-lost + closed when the socket drops without us calling close()', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);

    transport.host();
    sockets[0].open();
    sockets[0].receive({ type: 'hosted', code: 'ABCD', peerId: 'host' });

    sockets[0].onclose?.(); // simulate the relay dropping the link
    expect(eventsOfType(events, 'error')).toEqual([{ type: 'error', reason: 'connection-lost' }]);
    expect(eventsOfType(events, 'closed')).toHaveLength(1);
  });

  it('does NOT emit connection-lost when close() was called locally', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);

    transport.host();
    sockets[0].open();
    transport.close();

    expect(eventsOfType(events, 'error')).toHaveLength(0);
    expect(eventsOfType(events, 'closed')).toHaveLength(1);
  });
});

// ── connect timeout ──────────────────────────────────────────────────────────────────────
// A 2026-07-17 audit found host()/join() had NO timeout at all: if the relay opened the
// socket but never answered {type:'host'}/{type:'join'} with hosted/joined/error, `status`
// stayed 'connecting' forever with nothing to recover it (unlike NearbyTransport, which
// already had a guest-side scan timeout). These lock the fix in.

describe('OnlineTransport — connect timeout', () => {
  it('emits `error: timeout` if the relay never answers a host() request in time', async () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor, connectTimeoutMs: 20 });
    const events = collect(transport);

    transport.host();
    sockets[0].open(); // the socket connects fine — the relay just never replies

    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(eventsOfType(events, 'error')).toEqual([{ type: 'error', reason: 'timeout' }]);
  });

  it('emits `error: timeout` if the socket never even opens (join)', async () => {
    const { Ctor } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor, connectTimeoutMs: 20 });
    const events = collect(transport);

    transport.join('ABCD'); // never call sockets[0].open()

    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(eventsOfType(events, 'error')).toEqual([{ type: 'error', reason: 'timeout' }]);
  });

  it('does NOT time out once the relay answers before the deadline', async () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor, connectTimeoutMs: 30 });
    const events = collect(transport);

    transport.host();
    sockets[0].open();
    sockets[0].receive({ type: 'hosted', code: 'ABCD', peerId: 'host' });

    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    expect(eventsOfType(events, 'error')).toHaveLength(0);
    expect(eventsOfType(events, 'hosting')).toHaveLength(1);
  });

  it('a fresh join() after a timeout is not immediately re-timed-out by the stale timer', async () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor, connectTimeoutMs: 20 });
    const events = collect(transport);

    transport.join('AAAA');
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(eventsOfType(events, 'error')).toHaveLength(1); // the first timeout

    transport.join('BBBB'); // retry
    expect(sockets).toHaveLength(2); // the stalled socket was dropped, a fresh one opened
    sockets[1].open();
    sockets[1].receive({ type: 'joined', code: 'BBBB', peerId: 'guest-1', peers: ['host'] });

    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(eventsOfType(events, 'error')).toHaveLength(1); // still just the one, real timeout
    expect(eventsOfType(events, 'joined')).toHaveLength(1);
  });

  it('close() during the connecting window cancels the pending timeout', async () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor, connectTimeoutMs: 20 });
    const events = collect(transport);

    transport.host();
    sockets[0].open();
    transport.close();

    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(eventsOfType(events, 'error')).toHaveLength(0); // no stray timeout after a clean close
  });
});

// ── app-level heartbeat ──────────────────────────────────────────────────────────────────
// The live relay's WebSocket-level ping never reaches a client (Render/Cloudflare swallow it),
// so a phone that went to sleep was never dropped and its room hung forever. The transport now
// pings the relay itself and watches for silence. Fake timers: these cover minutes of wall time.

const pings = (socket: FakeSocket) => socket.sent.filter((m) => (m as { type?: string }).type === 'ping').length;

describe('OnlineTransport — heartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('pings as soon as the socket opens, then every 15 s', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    transport.host();
    expect(pings(sockets[0] ?? new FakeSocket(''))).toBe(0); // nothing before the socket is open
    sockets[0].open();
    sockets[0].receive({ type: 'hosted', code: 'ABCD', peerId: 'host' });
    // The first ping goes with the request: it is what makes the relay police this socket.
    expect(pings(sockets[0])).toBe(1);

    jest.advanceTimersByTime(14_999);
    expect(pings(sockets[0])).toBe(1);
    jest.advanceTimersByTime(1);
    expect(pings(sockets[0])).toBe(2);
    sockets[0].receive({ type: 'pong' });
    jest.advanceTimersByTime(15_000);
    expect(pings(sockets[0])).toBe(3);
    transport.close();
  });

  it('keeps a link alive for as long as the relay keeps answering', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);
    transport.host();
    sockets[0].open();
    sockets[0].receive({ type: 'hosted', code: 'ABCD', peerId: 'host' });

    for (let i = 0; i < 20; i++) { // five minutes of a quiet lobby
      jest.advanceTimersByTime(15_000);
      sockets[0].receive({ type: 'pong' });
    }
    expect(eventsOfType(events, 'error')).toHaveLength(0);
    expect(sockets[0].closed).toBe(false);
    transport.close();
  });

  it('declares a link dead after 40 s of silence, reports it like any drop, and stops pinging', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);
    transport.host();
    sockets[0].open();
    sockets[0].receive({ type: 'hosted', code: 'ABCD', peerId: 'host' });

    jest.advanceTimersByTime(40_000); // exactly at the limit — not yet
    expect(eventsOfType(events, 'error')).toHaveLength(0);
    jest.advanceTimersByTime(5_000); // the next check
    // The same two events an unexpected close produces, so the app's existing handling runs.
    expect(eventsOfType(events, 'error')).toEqual([{ type: 'error', reason: 'connection-lost' }]);
    expect(eventsOfType(events, 'closed')).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);

    const sentBefore = pings(sockets[0]);
    jest.advanceTimersByTime(60_000);
    expect(pings(sockets[0])).toBe(sentBefore); // the heartbeat died with the link
    expect(eventsOfType(events, 'error')).toHaveLength(1); // and nothing more is reported
  });

  it('does not count its own suspension (app backgrounded, phone asleep) as relay silence', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);
    transport.host();
    sockets[0].open();
    sockets[0].receive({ type: 'hosted', code: 'ABCD', peerId: 'host' });
    const before = pings(sockets[0]);

    // Two minutes pass with no timer running at all (React Native pauses JS timers in the
    // background); then the overdue check fires once, on resume.
    jest.setSystemTime(Date.now() + 120_000);
    jest.advanceTimersByTime(5_000);
    expect(eventsOfType(events, 'error')).toHaveLength(0); // not blamed on the relay
    expect(pings(sockets[0])).toBe(before + 1); // a ping at once, to find out if the link survived

    // If nothing answers that, the link really is gone — reported within the normal window.
    jest.advanceTimersByTime(45_000);
    expect(eventsOfType(events, 'error')).toEqual([{ type: 'error', reason: 'connection-lost' }]);
  });

  it('close() stops the heartbeat', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
    const events = collect(transport);
    transport.host();
    sockets[0].open();
    transport.close();

    jest.advanceTimersByTime(120_000);
    expect(pings(sockets[0])).toBe(1); // just the first one
    expect(eventsOfType(events, 'error')).toHaveLength(0);
  });

  it('honours custom ping/dead timings', () => {
    const { Ctor, sockets } = fakeWebSocketCtor();
    const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor, pingIntervalMs: 100, deadAfterMs: 400 });
    const events = collect(transport);
    transport.join('ABCD');
    sockets[0].open();
    jest.advanceTimersByTime(300);
    expect(pings(sockets[0])).toBe(4); // t = 0, 100, 200, 300
    jest.advanceTimersByTime(200);
    expect(eventsOfType(events, 'error')).toEqual([{ type: 'error', reason: 'connection-lost' }]);
  });
});

// ── a socket we let go of stays let go of ─────────────────────────────────────────────────
// A real WebSocket reports its close LATER. Before, a socket abandoned by the connect timeout
// could fire that late close after a retry had opened a new one — clearing the retry's timer,
// nulling its socket, and reporting connection-lost on a link that was fine.

describe('OnlineTransport — abandoned sockets', () => {
  it('a late close from a socket dropped by the connect timeout does not touch the retry', () => {
    jest.useFakeTimers();
    try {
      const { Ctor, sockets } = fakeWebSocketCtor();
      const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor, connectTimeoutMs: 20 });
      const events = collect(transport);

      transport.join('AAAA');
      const stalled = sockets[0];
      const lateClose = stalled.onclose; // what a real socket would call later
      jest.advanceTimersByTime(20);
      expect(eventsOfType(events, 'error')).toEqual([{ type: 'error', reason: 'timeout' }]);

      transport.join('AAAA'); // the player taps "try again"
      expect(sockets).toHaveLength(2);
      lateClose?.(); // …and only now does the stalled socket's close arrive
      expect(eventsOfType(events, 'error')).toHaveLength(1); // no spurious connection-lost

      sockets[1].open();
      expect(sockets[1].sent[0]).toEqual({ type: 'join', code: 'AAAA' }); // the retry's socket is intact
      // …and so is the retry's own connect timer: left unanswered, it still fires.
      jest.advanceTimersByTime(20);
      expect(eventsOfType(events, 'error')).toEqual([
        { type: 'error', reason: 'timeout' },
        { type: 'error', reason: 'timeout' },
      ]);
      transport.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a socket closed before it opened never starts a heartbeat', () => {
    jest.useFakeTimers();
    try {
      const { Ctor, sockets } = fakeWebSocketCtor();
      const transport = new OnlineTransport({ url: 'ws://test', WebSocketImpl: Ctor });
      transport.host();
      transport.close();
      sockets[0].open(); // a late open event
      jest.advanceTimersByTime(60_000);
      expect(sockets[0].sent).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
