// mojigames-common/ui — shared design tokens for Mojigames titles (HitMoji, Mojiventure …).
//
// Pure constants — no React, no native imports — so any RN/Expo game can pull them in. They
// define the Mojigames "look": per-category gradients, special-mode gradients, the shared
// raised-card shadow, and the radius/spacing scales. Pair a gradient with `Raised` plus a
// darker `borderBottom` "lip" for the signature 3D button (see GradientPill).

/** A gradient colour-stop tuple (≥2 stops), compatible with expo-linear-gradient's `colors`. */
export type Gradient = readonly [string, string, ...string[]];

/** Per-category button gradients (purple / cyan / gold / rose). `gold`/`silver` are kept for
 *  back-compat with the original web-app treatments. */
export const CategoryGradients: Record<string, Gradient> = {
  songs: ['#A65CFF', '#8B3FE8', '#6E27C2'], // logo purple
  movies: ['#4FC8F5', '#2AAAE0', '#1585C8'], // sky-blue cyan
  tv: ['#FFD24D', '#FFB81E', '#E0A000'], // golden yellow
  musicals: ['#F488C0', '#E0559A', '#B82E78'], // rose
  gold: ['#E1CFA6', '#C2A263', '#8E7846'],
  silver: ['#E4E6EB', '#AEB2BC', '#7E838E'],
};

/** Special-mode button gradients, in the logo's bright accent colours. */
export const ModeGradients: Record<string, Gradient> = {
  battle: ['#FF6A4E', '#E83026', '#C01A14'], // fiery red
  party: ['#3CD8C6', '#18C0AE', '#0E9688'], // turquoise
};

/** Border-radius scale. */
export const Radius = { sm: 7, md: 10, lg: 12, xl: 16, xxl: 20 } as const;

/** Spacing scale. */
export const Spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/**
 * The shared "3D card/button" drop-shadow. Spread into a card or button style, then pair it
 * with a darker `borderBottomWidth` "lip" (3–7px) for the full raised look.
 */
export const Raised = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 5 },
  shadowOpacity: 0.2,
  shadowRadius: 7,
  elevation: 6,
} as const;
