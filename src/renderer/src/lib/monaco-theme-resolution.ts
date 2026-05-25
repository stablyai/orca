import type { GlobalSettings } from '../../../shared/types'
import { ORCA_GLASS_LIGHT_THEME_NAME, ORCA_GLASS_DARK_THEME_NAME } from './monaco-glass-themes'

/**
 * Why: every Monaco consumer (file editor, diff viewer, ipynb viewer, code
 * excerpt) needs to pick the same theme so the editor surfaces look
 * consistent under glass themes. Without a single resolver, each consumer
 * drifts independently — Task 7's gap surfaced exactly this.
 *
 * Glass cases map to the registered orca-glass-* themes (defined in
 * monaco-glass-themes.ts and registered at bootstrap in monaco-setup.ts).
 * Non-glass cases keep the existing vs / vs-dark mapping driven by the
 * resolved-dark boolean.
 */
export function resolveMonacoThemeName(
  theme: GlobalSettings['theme'] | undefined,
  isDark: boolean
): string {
  if (theme === 'glass-dark') {
    return ORCA_GLASS_DARK_THEME_NAME
  }
  if (theme === 'glass-light') {
    return ORCA_GLASS_LIGHT_THEME_NAME
  }
  return isDark ? 'vs-dark' : 'vs'
}
