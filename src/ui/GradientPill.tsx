// GradientPill — the Mojigames "3D gradient pill" button: a per-item gradient fill with a
// raised shadow + a darker bottom "lip", an optional white selection ring, and dimmed
// unselected siblings. The shared building block behind HitMoji's category / mode buttons;
// any Mojigames title can reuse it for a consistent look.
//
// Needs the `expo-linear-gradient` peer dependency (both games already ship it).

import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { Radius, Raised, type Gradient } from './theme';

export interface GradientPillProps {
  /** Gradient colour stops, e.g. `CategoryGradients.songs`. */
  gradient: Gradient;
  /** Leading emoji/glyph shown above the label. */
  icon?: string;
  /** Button label. */
  label?: string;
  /** When false the pill dims to 0.55 — use for the unselected items in a picker. Default true. */
  selected?: boolean;
  /** Tap handler. */
  onPress?: () => void;
  /** Extra style on the outer Pressable (e.g. width / margins). */
  style?: StyleProp<ViewStyle>;
  /** Accessibility label (defaults to `label`). */
  accessibilityLabel?: string;
  /** Custom content rendered instead of the icon + label. */
  children?: ReactNode;
}

export function GradientPill({
  gradient,
  icon,
  label,
  selected = true,
  onPress,
  style,
  accessibilityLabel,
  children,
}: GradientPillProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.pill,
        !selected && styles.dim,
        pressed && styles.pressed,
        style,
      ]}
    >
      <LinearGradient
        colors={gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[StyleSheet.absoluteFill, styles.grad, selected && styles.gradOn]}
      />
      {children ?? (
        <>
          {icon ? <Text style={styles.icon}>{icon}</Text> : null}
          {label ? <Text style={styles.label}>{label}</Text> : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 12,
    borderRadius: Radius.md,
    // Opaque bg so the Raised shadow casts cleanly — the gradient layer covers it.
    backgroundColor: '#FFFFFF',
    ...Raised,
    // Deeper than the base Raised shadow → a more pronounced 3D "pop".
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.32,
    shadowRadius: 10,
    elevation: 10,
  },
  dim: { opacity: 0.55 },
  pressed: { opacity: 0.85 },
  grad: {
    borderRadius: Radius.md,
    // The 3D "lip" — a darker bottom edge makes the button look raised.
    borderBottomWidth: 7,
    borderBottomColor: 'rgba(0,0,0,0.28)',
  },
  gradOn: {
    // White selection ring for the picked pill (others dim back via `dim`).
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
    borderBottomColor: 'rgba(0,0,0,0.34)',
  },
  icon: { fontSize: 20 },
  label: {
    fontSize: 11,
    fontWeight: '800',
    color: '#FFFFFF',
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
