// NearbyTransport tests — the `nearby` (in-person) transport. They run a fake
// `expo-nearby-connections` (injected via the constructor) so the host/join/connect/
// send/receive flow and the discovery→code mapping are exercised with no native module.
//
// What is NOT covered here is the native bridge itself — that needs a device and a custom
// dev build. These tests lock in the transport's own logic: code minting, the Transport
// event mapping, the 1v1 guards, and teardown.

import { makeNearbyCode, NearbyTransport, type NearbyApi } from './nearby-transport';
import type { TransportEvent } from '../multiplayer';

// ── A fake expo-nearby-connections ───────────────────────────────────────────────────────

type EventName =
  | 'peerFound'
  | 'invitationReceived'
  | 'connected'
  | 'disconnected'
  | 'textReceived';

interface FakeNearby {
  /** The NearbyApi handed to the transport. */
  api: NearbyApi;
  /** Every method call the transport made, in order. */
  calls: { method: string; args: unknown[] }[];
  /** Push a native event into the transport's listeners. */
  fire: {
    peerFound(data: { peerId: string; name: string }): void;
    invitationReceived(data: { peerId: string; name: string }): void;
    connected(data: { peerId: string; name: string }): void;
    disconnected(data: { peerId: string }): void;
    textReceived(data: { peerId: string; text: string }): void;
  };
}

function createFakeNearby(): FakeNearby {
  const calls: { method: string; args: unknown[] }[] = [];
  const listeners: Record<EventName, Set<(data: unknown) => void>> = {
    peerFound: new Set(),
    invitationReceived: new Set(),
    connected: new Set(),
    disconnected: new Set(),
    textReceived: new Set(),
  };

  /** A void-returning method that records its call. */
  const track =
    (method: string) =>
    (...args: unknown[]): Promise<void> => {
      calls.push({ method, args });
      return Promise.resolve();
    };
  /** A method that records its call and resolves with a peer id (start*). */
  const trackId =
    (method: string, id: string) =>
    (...args: unknown[]): Promise<string> => {
      calls.push({ method, args });
      return Promise.resolve(id);
    };
  /** An event-listener registrar. */
  const reg =
    (event: EventName) =>
    (callback: (data: never) => void): (() => void) => {
      const cb = callback as (data: unknown) => void;
      listeners[event].add(cb);
      return () => {
        listeners[event].delete(cb);
      };
    };
  const fireEvent = (event: EventName, data: unknown): void => {
    for (const cb of [...listeners[event]]) cb(data);
  };

  const api: NearbyApi = {
    startAdvertise: trackId('startAdvertise', 'host-self'),
    stopAdvertise: track('stopAdvertise'),
    startDiscovery: trackId('startDiscovery', 'guest-self'),
    stopDiscovery: track('stopDiscovery'),
    requestConnection: track('requestConnection'),
    acceptConnection: track('acceptConnection'),
    rejectConnection: track('rejectConnection'),
    disconnect: track('disconnect'),
    sendText: track('sendText'),
    onPeerFound: reg('peerFound'),
    onInvitationReceived: reg('invitationReceived'),
    onConnected: reg('connected'),
    onDisconnected: reg('disconnected'),
    onTextReceived: reg('textReceived'),
  };

  return {
    api,
    calls,
    fire: {
      peerFound: (data) => fireEvent('peerFound', data),
      invitationReceived: (data) => fireEvent('invitationReceived', data),
      connected: (data) => fireEvent('connected', data),
      disconnected: (data) => fireEvent('disconnected', data),
      textReceived: (data) => fireEvent('textReceived', data),
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

/** Drain the promise chain in host()/join() (permission check → start* → emit). */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Subscribe and return the growing list of events the transport emits. */
function collect(transport: NearbyTransport): TransportEvent[] {
  const events: TransportEvent[] = [];
  transport.subscribe((event) => events.push(event));
  return events;
}

/** All emitted events of one type, narrowed. */
function eventsOfType<T extends TransportEvent['type']>(
  events: TransportEvent[],
  type: T,
): Extract<TransportEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<TransportEvent, { type: T }> => event.type === type,
  );
}

/** The method names the transport called on the fake, in order. */
const methodNames = (fake: FakeNearby): string[] => fake.calls.map((call) => call.method);

// ── makeNearbyCode ───────────────────────────────────────────────────────────────────────

describe('makeNearbyCode', () => {
  it('mints a 4-character code from the unambiguous alphabet', () => {
    for (let i = 0; i < 100; i++) {
      // No easily-confused glyphs — same alphabet as the relay server's makeCode.
      expect(makeNearbyCode()).toMatch(/^[ACDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
    }
  });

  it('does not return the same code every time', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add(makeNearbyCode());
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ── Host flow ────────────────────────────────────────────────────────────────────────────

describe('NearbyTransport — host', () => {
  it('advertises a minted code and emits `hosting`', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host();
    await flush();

    const hosting = eventsOfType(events, 'hosting');
    expect(hosting).toHaveLength(1);
    expect(hosting[0].selfId).toBe('host-self');
    expect(hosting[0].code).toMatch(/^[A-Z2-9]{4}$/);
    // The advertised name IS the share code — that is how the guest finds this device.
    const advertise = fake.calls.find((call) => call.method === 'startAdvertise');
    expect(advertise?.args[0]).toBe(hosting[0].code);
  });

  it('accepts an invitation and emits `peer-join` once connected', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host();
    await flush();

    fake.fire.invitationReceived({ peerId: 'guest-1', name: 'Player 2' });
    expect(fake.calls.find((c) => c.method === 'acceptConnection')?.args[0]).toBe('guest-1');

    fake.fire.connected({ peerId: 'guest-1', name: 'Player 2' });
    const joins = eventsOfType(events, 'peer-join');
    expect(joins).toHaveLength(1);
    expect(joins[0].peerId).toBe('guest-1');
    // The room is full — advertising stops so no one else discovers it.
    expect(methodNames(fake)).toContain('stopAdvertise');
  });

  it('rejects a second guest — Versus is 1v1', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host();
    await flush();
    fake.fire.invitationReceived({ peerId: 'guest-1', name: 'P2' });
    fake.fire.connected({ peerId: 'guest-1', name: 'P2' });

    fake.fire.invitationReceived({ peerId: 'guest-2', name: 'P3' });
    expect(fake.calls.find((c) => c.method === 'rejectConnection')?.args[0]).toBe('guest-2');
    // Still only the one opponent.
    expect(eventsOfType(events, 'peer-join')).toHaveLength(1);
  });
});

// ── Guest flow ───────────────────────────────────────────────────────────────────────────

describe('NearbyTransport — guest', () => {
  it('connects only to the advertiser whose name matches the code', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    // The player typed the code with stray spacing / lowercase — it is normalised.
    transport.join(' abcd ');
    await flush();
    expect(methodNames(fake)).toContain('startDiscovery');

    // A different room's host — ignored.
    fake.fire.peerFound({ peerId: 'other-host', name: 'ZZZZ' });
    expect(fake.calls.some((c) => c.method === 'requestConnection')).toBe(false);

    // Our host — its advertised name is the code we are looking for.
    fake.fire.peerFound({ peerId: 'our-host', name: 'ABCD' });
    expect(fake.calls.find((c) => c.method === 'requestConnection')?.args[0]).toBe('our-host');

    fake.fire.connected({ peerId: 'our-host', name: 'ABCD' });
    const joined = eventsOfType(events, 'joined');
    expect(joined).toHaveLength(1);
    expect(joined[0].selfId).toBe('guest-self');
    expect(joined[0].code).toBe('ABCD');
    expect(joined[0].peers).toEqual(['our-host']);
  });

  it('emits `no-room` when no advertiser with the code turns up in time', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api, connectTimeoutMs: 40 });
    const events = collect(transport);

    transport.join('WXYZ');
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    const errors = eventsOfType(events, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe('no-room');
  });
});

// ── Messaging ────────────────────────────────────────────────────────────────────────────

describe('NearbyTransport — messaging', () => {
  it('serialises send() and parses received text into a `message` event', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host();
    await flush();
    fake.fire.invitationReceived({ peerId: 'guest-1', name: 'P2' });
    fake.fire.connected({ peerId: 'guest-1', name: 'P2' });

    transport.send({ kind: 'hello', name: 'Beth' });
    const sent = fake.calls.find((c) => c.method === 'sendText');
    expect(sent?.args).toEqual(['guest-1', JSON.stringify({ kind: 'hello', name: 'Beth' })]);

    fake.fire.textReceived({ peerId: 'guest-1', text: '{"kind":"progress","score":7}' });
    const messages = eventsOfType(events, 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe('guest-1');
    expect(messages[0].data).toEqual({ kind: 'progress', score: 7 });
  });

  it('ignores a non-JSON text frame instead of emitting a broken message', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host();
    await flush();
    fake.fire.invitationReceived({ peerId: 'guest-1', name: 'P2' });
    fake.fire.connected({ peerId: 'guest-1', name: 'P2' });

    fake.fire.textReceived({ peerId: 'guest-1', text: 'not json' });
    expect(eventsOfType(events, 'message')).toHaveLength(0);
  });

  it('emits `peer-leave` when the opponent disconnects', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host();
    await flush();
    fake.fire.invitationReceived({ peerId: 'guest-1', name: 'P2' });
    fake.fire.connected({ peerId: 'guest-1', name: 'P2' });

    fake.fire.disconnected({ peerId: 'guest-1' });
    const leaves = eventsOfType(events, 'peer-leave');
    expect(leaves).toHaveLength(1);
    expect(leaves[0].peerId).toBe('guest-1');
  });
});

// ── Unavailable + teardown ───────────────────────────────────────────────────────────────

describe('NearbyTransport — unavailable & close', () => {
  it('emits `nearby-unavailable` when the native module is absent', () => {
    // `nearby: null` simulates Expo Go / web (the guarded loader returned null).
    const transport = new NearbyTransport({ nearby: null });
    const events = collect(transport);

    transport.host();

    const errors = eventsOfType(events, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe('nearby-unavailable');
  });

  it('tears the session down on close() and stops reacting to events', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host();
    await flush();
    fake.fire.invitationReceived({ peerId: 'guest-1', name: 'P2' });
    fake.fire.connected({ peerId: 'guest-1', name: 'P2' });

    transport.close();
    expect(eventsOfType(events, 'closed')).toHaveLength(1);
    expect(methodNames(fake)).toEqual(
      expect.arrayContaining(['stopAdvertise', 'stopDiscovery', 'disconnect']),
    );

    // A late native event after close() must not produce any further transport events.
    const countAfterClose = events.length;
    fake.fire.textReceived({ peerId: 'guest-1', text: '{"kind":"progress"}' });
    fake.fire.disconnected({ peerId: 'guest-1' });
    expect(events).toHaveLength(countAfterClose);
  });
});

// ── N-player party (size > 2) ────────────────────────────────────────────────────────────

describe('NearbyTransport — N-player party', () => {
  it('accepts (size - 1) guests when host({ size: N }) is called', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host({ size: 4 }); // host + 3 guests
    await flush();

    // First three guests are accepted and produce peer-join events.
    for (const id of ['g1', 'g2', 'g3']) {
      fake.fire.invitationReceived({ peerId: id, name: 'P' });
      fake.fire.connected({ peerId: id, name: 'P' });
    }
    expect(eventsOfType(events, 'peer-join')).toHaveLength(3);

    // Every accept call landed on the right guest, in order.
    const accepts = fake.calls
      .filter((c) => c.method === 'acceptConnection')
      .map((c) => c.args[0]);
    expect(accepts).toEqual(['g1', 'g2', 'g3']);

    // The room is now full — stopAdvertise was called once we hit (size - 1) guests.
    expect(methodNames(fake)).toContain('stopAdvertise');
  });

  it('rejects guests beyond the room size', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host({ size: 3 }); // host + 2 guests
    await flush();

    fake.fire.invitationReceived({ peerId: 'g1', name: 'P' });
    fake.fire.connected({ peerId: 'g1', name: 'P' });
    fake.fire.invitationReceived({ peerId: 'g2', name: 'P' });
    fake.fire.connected({ peerId: 'g2', name: 'P' });

    // Room is now full — the third guest is rejected, no peer-join.
    fake.fire.invitationReceived({ peerId: 'g3', name: 'P' });
    const rejects = fake.calls
      .filter((c) => c.method === 'rejectConnection')
      .map((c) => c.args[0]);
    expect(rejects).toEqual(['g3']);
    expect(eventsOfType(events, 'peer-join')).toHaveLength(2);
  });

  it('broadcasts send() to every connected guest', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });

    transport.host({ size: 4 });
    await flush();
    for (const id of ['g1', 'g2', 'g3']) {
      fake.fire.invitationReceived({ peerId: id, name: 'P' });
      fake.fire.connected({ peerId: id, name: 'P' });
    }

    transport.send({ kind: 'party:roster', players: [] });

    const recipients = fake.calls
      .filter((c) => c.method === 'sendText')
      .map((c) => c.args[0]);
    // Order is set-iteration order — assert membership, not sequence.
    expect(recipients).toHaveLength(3);
    expect(new Set(recipients)).toEqual(new Set(['g1', 'g2', 'g3']));
  });

  it('relays a guest text frame to every OTHER guest (host star-relay)', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.host({ size: 4 });
    await flush();
    for (const id of ['g1', 'g2', 'g3']) {
      fake.fire.invitationReceived({ peerId: id, name: 'P' });
      fake.fire.connected({ peerId: id, name: 'P' });
    }

    // g1 sends a frame; the host should emit `message` locally AND relay it to g2 & g3.
    const frame = '{"kind":"party:progress","id":"g1","score":42,"roundsDone":1,"done":false}';
    fake.fire.textReceived({ peerId: 'g1', text: frame });

    const messages = eventsOfType(events, 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe('g1');

    // Relay went out to the OTHER guests, not back to the sender.
    const relays = fake.calls
      .filter((c) => c.method === 'sendText')
      .map((c) => c.args[0]);
    expect(relays).toHaveLength(2);
    expect(new Set(relays)).toEqual(new Set(['g2', 'g3']));
  });

  it('restarts advertising when a guest leaves and a slot opens up', async () => {
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });

    transport.host({ size: 3 });
    await flush();
    fake.fire.invitationReceived({ peerId: 'g1', name: 'P' });
    fake.fire.connected({ peerId: 'g1', name: 'P' });
    fake.fire.invitationReceived({ peerId: 'g2', name: 'P' });
    fake.fire.connected({ peerId: 'g2', name: 'P' });

    // Room is full — exactly one stopAdvertise so far.
    const stopsBefore = methodNames(fake).filter((m) => m === 'stopAdvertise').length;
    expect(stopsBefore).toBe(1);

    // A guest leaves — the room has room again, so advertising restarts.
    fake.fire.disconnected({ peerId: 'g1' });
    const restarts = methodNames(fake).filter((m) => m === 'startAdvertise').length;
    // Initial startAdvertise + the restart after the disconnect.
    expect(restarts).toBe(2);
  });

  it('guest still only connects to one host even after multiple peers are found', async () => {
    // The N-player extension is host-only — the guest's behaviour is unchanged: it
    // connects to the first matching advertiser and ignores the rest.
    const fake = createFakeNearby();
    const transport = new NearbyTransport({ nearby: fake.api });
    const events = collect(transport);

    transport.join('ABCD');
    await flush();
    fake.fire.peerFound({ peerId: 'host-a', name: 'ABCD' });
    fake.fire.connected({ peerId: 'host-a', name: 'ABCD' });

    // A second host shows up after we've already connected — should be ignored.
    fake.fire.peerFound({ peerId: 'host-b', name: 'ABCD' });
    const requestArgs = fake.calls
      .filter((c) => c.method === 'requestConnection')
      .map((c) => c.args[0]);
    expect(requestArgs).toEqual(['host-a']);
    expect(eventsOfType(events, 'joined')).toHaveLength(1);
  });
});
