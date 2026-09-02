import type { GlobalSettings } from '../../../shared/global-settings-types'
import { HEX_COLOR_RE } from '../../../shared/color-validation'
import {
  normalizeSidebarTintColor,
  normalizeSidebarTintOpacity
} from '../../../shared/sidebar-appearance'
import type { SidebarAppearanceMode } from '../../../shared/ui-chrome-types'
import { resolveEffectiveTerminalAppearance } from './terminal-theme'

export type SidebarStyleVariables = Record<string, string>

function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeSidebarTintColor(hex)
  let clean = normalized.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((part) => part + part)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function applyAlpha(color: string, alpha: number | undefined): string {
  if (alpha === undefined || alpha >= 1 || !HEX_COLOR_RE.test(color.trim())) {
    return color
  }
  return hexToRgba(color, Math.min(1, Math.max(0, alpha)))
}

function buildSurfaceVariables(args: {
  background: string
  foreground: string
  includeWorktreeTokens: boolean
  overrideTextTokens?: boolean
}): SidebarStyleVariables {
  const { background, foreground, includeWorktreeTokens, overrideTextTokens = false } = args
  const accent = `color-mix(in srgb, ${foreground} 9%, ${background})`
  const border = `color-mix(in srgb, ${foreground} 7%, ${background})`
  const ring = `color-mix(in srgb, ${foreground} 44%, ${background})`
  const vars: SidebarStyleVariables = {
    '--sidebar': background,
    '--sidebar-foreground': foreground,
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': foreground,
    '--sidebar-border': border,
    '--sidebar-ring': ring
  }
  if (includeWorktreeTokens) {
    Object.assign(vars, {
      '--worktree-sidebar': background,
      '--worktree-sidebar-foreground': foreground,
      '--worktree-sidebar-accent': accent,
      '--worktree-sidebar-accent-foreground': foreground,
      '--worktree-sidebar-border': border,
      '--worktree-sidebar-ring': ring
    })
  }
  if (overrideTextTokens) {
    vars['--background'] = background
    vars['--foreground'] = foreground
    vars['--card'] = `color-mix(in srgb, ${foreground} 4%, ${background})`
    vars['--card-foreground'] = foreground
    vars['--accent'] = accent
    vars['--accent-foreground'] = foreground
    vars['--muted'] = `color-mix(in srgb, ${foreground} 7%, ${background})`
    vars['--muted-foreground'] = `color-mix(in srgb, ${foreground} 62%, ${background})`
    vars['--border'] = border
  }
  return vars
}

function resolveAppearanceStyleVariables(args: {
  settings: GlobalSettings
  mode: SidebarAppearanceMode | undefined
  tintColor: string | undefined
  tintOpacity: number | undefined
  systemPrefersDark: boolean
  includeWorktreeTokens: boolean
}): SidebarStyleVariables | undefined {
  const { settings, mode, tintColor, tintOpacity, systemPrefersDark, includeWorktreeTokens } = args
  switch (mode ?? 'default') {
    case 'default':
      return undefined
    case 'match-terminal': {
      const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
      const background = applyAlpha(
        settings.terminalColorOverrides?.background ?? appearance.theme?.background ?? '#000000',
        settings.terminalBackgroundOpacity
      )
      const foreground =
        settings.terminalColorOverrides?.foreground ?? appearance.theme?.foreground ?? '#fafafa'
      return buildSurfaceVariables({
        background,
        foreground,
        includeWorktreeTokens,
        overrideTextTokens: true
      })
    }
    case 'tinted': {
      const normalizedColor = normalizeSidebarTintColor(tintColor)
      const tintPercent = Number((normalizeSidebarTintOpacity(tintOpacity) * 100).toFixed(2))
      return buildSurfaceVariables({
        background: `color-mix(in srgb, ${normalizedColor} ${tintPercent}%, var(--background))`,
        foreground: 'var(--foreground)',
        includeWorktreeTokens
      })
    }
  }
}

export function resolveLeftSidebarStyleVariables(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean
): SidebarStyleVariables | undefined {
  if (!settings) {
    return undefined
  }
  return resolveAppearanceStyleVariables({
    settings,
    mode: settings.leftSidebarAppearanceMode,
    tintColor: settings.leftSidebarTintColor,
    tintOpacity: settings.leftSidebarTintOpacity,
    systemPrefersDark,
    includeWorktreeTokens: true
  })
}

export function resolveRightSidebarStyleVariables(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean
): SidebarStyleVariables | undefined {
  if (!settings) {
    return undefined
  }
  return resolveAppearanceStyleVariables({
    settings,
    mode: settings.rightSidebarAppearanceMode,
    tintColor: settings.rightSidebarTintColor,
    tintOpacity: settings.rightSidebarTintOpacity,
    systemPrefersDark,
    includeWorktreeTokens: false
  })
}
