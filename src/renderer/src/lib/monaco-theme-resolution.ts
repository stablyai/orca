import type { GlobalSettings } from '../../../shared/types'
import { ORCA_GLASS_LIGHT_THEME_NAME, ORCA_GLASS_DARK_THEME_NAME } from './monaco-glass-themes'

/**
 * Why: every Monaco consumer (file editor, diff viewer, ipynb viewer, code
 * excerpt) needs to pick the same theme so the editor surfaces look
 * consistent. Without a single resolver, each consumer drifts independently.
 *
 * When glass effect is on, picks the registered orca-glass-* theme (which
 * paints a transparent canvas so the underlying CSS surface shows through).
 * When glass effect is off, keeps the standard vs / vs-dark mapping driven
 * by the resolved-dark boolean.
 */
export function resolveMonacoThemeName(
  settings: Pick<GlobalSettings, 'glassEffect'> | null | undefined,
  isDark: boolean
): string {
  if (settings?.glassEffect) {
    return isDark ? ORCA_GLASS_DARK_THEME_NAME : ORCA_GLASS_LIGHT_THEME_NAME
  }
  return isDark ? 'vs-dark' : 'vs'
}
