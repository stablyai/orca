import type { GlobalSettings } from '../../../shared/types'
import { isGlassEffectActive } from '../../../shared/glass-theme'
import { ORCA_GLASS_LIGHT_THEME_NAME, ORCA_GLASS_DARK_THEME_NAME } from './monaco-glass-themes'

/**
 * Why: every Monaco consumer (file editor, diff viewer, ipynb viewer, code
 * excerpt) needs to pick the same theme so the editor surfaces look
 * consistent. Without a single resolver, each consumer drifts independently.
 *
 * When glass effect is active on macOS, picks the registered orca-glass-*
 * theme (which paints a transparent canvas so the underlying CSS surface
 * shows through). On non-macOS hosts, a persisted glassEffect flag is ignored
 * and the standard vs / vs-dark mapping stays in use.
 */
export function resolveMonacoThemeName(
  settings: Pick<GlobalSettings, 'glassEffect'> | null | undefined,
  isDark: boolean,
  options?: { isDarwin?: boolean }
): string {
  if (isGlassEffectActive(settings, options)) {
    return isDark ? ORCA_GLASS_DARK_THEME_NAME : ORCA_GLASS_LIGHT_THEME_NAME
  }
  return isDark ? 'vs-dark' : 'vs'
}
