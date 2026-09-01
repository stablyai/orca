import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  normalizeLeftSidebarTintColor,
  normalizeLeftSidebarTintOpacity
} from '../../../shared/left-sidebar-appearance'
import {
  buildSidebarTokenVariables,
  buildSurfaceTextTokenVariables,
  resolveTerminalSurfaceColors,
  type TerminalSurfaceSettings
} from './terminal-surface-colors'

type LeftSidebarAppearanceSettings = TerminalSurfaceSettings &
  Pick<
    GlobalSettings,
    'leftSidebarAppearanceMode' | 'leftSidebarTintColor' | 'leftSidebarTintOpacity'
  >

export type LeftSidebarStyleVariables = Record<string, string>

/** Sidebar token variables for one color pair, optionally re-deriving the text/surface tokens too. */
function buildSurfaceVariables(args: {
  background: string
  foreground: string
  overrideTextTokens?: boolean
}): LeftSidebarStyleVariables {
  const { background, foreground, overrideTextTokens = false } = args
  return {
    ...buildSidebarTokenVariables({ background, foreground }),
    ...(overrideTextTokens ? buildSurfaceTextTokenVariables({ background, foreground }) : {})
  }
}

/** Match-terminal mode: sidebar variables derived from the active terminal theme. */
function resolveTerminalSurfaceVariables(
  settings: LeftSidebarAppearanceSettings,
  systemPrefersDark: boolean
): LeftSidebarStyleVariables {
  const { background, foreground } = resolveTerminalSurfaceColors(settings, systemPrefersDark)
  return buildSurfaceVariables({ background, foreground, overrideTextTokens: true })
}

function resolveTintedSurfaceVariables(
  settings: LeftSidebarAppearanceSettings
): LeftSidebarStyleVariables {
  const tintColor = normalizeLeftSidebarTintColor(settings.leftSidebarTintColor)
  const tintOpacity = normalizeLeftSidebarTintOpacity(settings.leftSidebarTintOpacity)
  const tintPercent = Number((tintOpacity * 100).toFixed(2))
  const background = `color-mix(in srgb, ${tintColor} ${tintPercent}%, var(--background))`
  return buildSurfaceVariables({ background, foreground: 'var(--foreground)' })
}

export function resolveLeftSidebarStyleVariables(
  settings: LeftSidebarAppearanceSettings | null | undefined,
  systemPrefersDark: boolean
): LeftSidebarStyleVariables | undefined {
  if (!settings) {
    return undefined
  }
  switch (settings.leftSidebarAppearanceMode) {
    case 'default':
      return undefined
    case 'match-terminal':
      return resolveTerminalSurfaceVariables(settings, systemPrefersDark)
    case 'tinted':
      return resolveTintedSurfaceVariables(settings)
  }
}
