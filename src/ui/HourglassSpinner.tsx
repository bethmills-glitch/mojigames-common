// HourglassSpinner — a spinning ⏳ for "we're working on it" waits shorter than a full loading
// screen deserves (minting a room code, dialing the relay). Plain RN `Animated` + a native-driver
// rotation loop, not Reanimated — the animation is a single transform with no gesture/worklet
// need, so it isn't worth taking Reanimated on as a new peer dependency of this package just for
// this. Any Mojigames title can drop it into a "connecting…" state for a consistent wait animation.

import { useEffect, useRef } from 'react';
import { Animated, Easing, type StyleProp, type TextStyle } from 'react-native';

export interface HourglassSpinnerProps {
  /** Glyph font size in px. Defaults to 40. */
  size?: number;
  /** Extra style on the glyph (e.g. margin) — merged after the animated transform. */
  style?: StyleProp<TextStyle>;
}

export function HourglassSpinner({ size = 40, style }: HourglassSpinnerProps) {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1600,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.Text style={[{ fontSize: size, transform: [{ rotate }] }, style]} accessibilityLabel="Loading">
      ⏳
    </Animated.Text>
  );
}
