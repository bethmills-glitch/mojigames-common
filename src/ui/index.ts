// mojigames-common/ui — the shared Mojigames design system.
//
// Public surface:
//   • Design tokens — CategoryGradients, ModeGradients, Raised, Radius, Spacing (pure
//     constants, no extra deps).
//   • GradientPill — the 3D gradient "pill" button built from those tokens (needs the
//     `expo-linear-gradient` peer dependency).
//
// Any Mojigames title (HitMoji, Mojiventure …) can import these for a consistent look:
//   import { CategoryGradients, GradientPill, Raised } from 'mojigames-common/ui';

export {
  CategoryGradients,
  ModeGradients,
  Radius,
  Spacing,
  Raised,
  type Gradient,
} from './theme';
export { GradientPill, type GradientPillProps } from './GradientPill';
