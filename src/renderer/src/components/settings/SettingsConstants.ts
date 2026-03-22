import type { OrcaHooks } from '../../../../shared/types'
import { getDefaultRepoHookSettings } from '../../../../shared/constants'

export type HookName = keyof OrcaHooks['scripts']
export const DEFAULT_REPO_HOOK_SETTINGS = getDefaultRepoHookSettings()
export const MAX_THEME_RESULTS = 80
export const MAX_FONT_RESULTS = 12
export const SCROLLBACK_PRESETS_MB = [10, 25, 50, 100, 250] as const
export const ZOOM_STEP = 0.5
export const ZOOM_MIN = -3
export const ZOOM_MAX = 5

export function zoomLevelToPercent(level: number): number {
  return Math.round(100 * Math.pow(1.2, level))
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
