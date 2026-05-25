import type { GlobalSettings } from './types'

export type GlassThemeValue = 'glass-light' | 'glass-dark'

/**
 * Why: the predicate `theme === 'glass-light' || theme === 'glass-dark'`
 * appears at 5+ sites across the main and renderer processes (window
 * vibrancy injection, terminal opacity defaults, pane opacity guards,
 * WebGL renderer selection, settings UI). Centralizing it here means a
 * new glass variant only needs to be added in one place, and call sites
 * gain TypeScript narrowing via the type guard.
 */
export function isGlassTheme(
  theme: GlobalSettings['theme'] | undefined | null
): theme is GlassThemeValue {
  return theme === 'glass-light' || theme === 'glass-dark'
}
