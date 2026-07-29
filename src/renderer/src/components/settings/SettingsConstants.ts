import type { OrcaHooks } from '../../../../shared/types'
import { DEFAULT_APP_FONT_FAMILY, getDefaultRepoHookSettings } from '../../../../shared/constants'
import { DESKTOP_TERMINAL_SCROLLBACK_ROW_PRESETS } from '../../../../shared/terminal-scrollback-policy'

export type HookName = keyof OrcaHooks['scripts']
export const DEFAULT_REPO_HOOK_SETTINGS = getDefaultRepoHookSettings()
export const MAX_THEME_RESULTS = 80
export const SCROLLBACK_PRESETS_ROWS = DESKTOP_TERMINAL_SCROLLBACK_ROW_PRESETS
export {
  UI_ZOOM_STEP as ZOOM_STEP,
  UI_ZOOM_MIN as ZOOM_MIN,
  UI_ZOOM_MAX as ZOOM_MAX
} from '../../../../shared/ui-zoom-level'

export function zoomLevelToPercent(level: number): number {
  return Math.round(100 * Math.pow(1.2, level))
}

export function mergeFontSuggestions(
  systemFonts: readonly string[],
  previousFonts: readonly string[]
): string[] {
  // Why: picker rendering can be capped later, but the source list must keep
  // every installed font searchable/selectable.
  return Array.from(new Set([DEFAULT_APP_FONT_FAMILY, ...systemFonts, ...previousFonts]))
}

export function getFallbackTerminalFonts(): string[] {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { userAgentData?: { platform?: string } })
      : null
  const platform = nav ? (nav.userAgentData?.platform ?? nav.platform ?? '') : ''
  const normalizedPlatform = platform.toLowerCase()

  if (normalizedPlatform.includes('mac')) {
    return ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code']
  }

  if (normalizedPlatform.includes('win')) {
    return ['Cascadia Mono', 'Consolas', 'Lucida Console', 'JetBrains Mono', 'Fira Code']
  }

  return [
    'JetBrains Mono',
    'Fira Code',
    'DejaVu Sans Mono',
    'Liberation Mono',
    'Ubuntu Mono',
    'Noto Sans Mono'
  ]
}
