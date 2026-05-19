// mojigames-common/nearby — the `nearby` (in-person) transport.
//
// Same-room play between two phones over expo-nearby-connections (Apple
// MultipeerConnectivity / Google Nearby Connections) — no internet, no relay server. It
// implements the `Transport` interface from `mojigames-common/multiplayer`, so it drops
// into `useMultiplayer` exactly like `OnlineTransport`.
//
// expo-nearby-connections is a native module: this works on a dev build, degrades to
// `isNearbyAvailable() === false` in Expo Go, and is absent on web (a platform-split
// loader keeps the native module out of the web bundle entirely).

export {
  NearbyTransport,
  isNearbyAvailable,
  makeNearbyCode,
} from './nearby-transport';
export type {
  NearbyApi,
  NearbyPeer,
  NearbyTransportOptions,
  NearbyUnsubscribe,
} from './nearby-transport';
