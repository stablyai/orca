import type { GlobalSettings } from '../../../shared/types'
import { HEX_COLOR_RE } from '../../../shared/color-validation'
import {
  normalizeLeftSidebarTintColor,
  normalizeLeftSidebarTintOpacity
} from '../../../shared/left-sidebar-appearance'
import { resolveEffectiveTerminalAppearance } from './terminal-theme'

type LeftSidebarAppearanceSettings = Pick<
  GlobalSettings,
  | 'leftSidebarAppearanceMode'
  | 'leftSidebarTintColor'
  | 'leftSidebarTintOpacity'
  | 'theme'
  | 'terminalThemeDark'
  | 'terminalDividerColorDark'
  | 'terminalUseSeparateLightTheme'
  | 'terminalThemeLight'
  | 'terminalCustomThemes'
  | 'terminalDividerColorLight'
  | 'terminalColorOverrides'
  | 'terminalBackgroundOpacity'
>

export type LeftSidebarStyleVariables = Record<string, string>

function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeLeftSidebarTintColor(hex)
  let clean = normalized.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((part) => part + part)
      .join('')
  }
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
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
  overrideTextTokens?: boolean
}): LeftSidebarStyleVariables {
  const { background, foreground, overrideTextTokens = false } = args
  const accent = `color-mix(in srgb, ${foreground} 9%, ${background})`
  const border = `color-mix(in srgb, ${foreground} 14%, ${background})`
  const ring = `color-mix(in srgb, ${foreground} 44%, ${background})`
  const vars: LeftSidebarStyleVariables = {
    '--worktree-sidebar': background,
    '--worktree-sidebar-foreground': foreground,
    '--worktree-sidebar-accent': accent,
    '--worktree-sidebar-accent-foreground': foreground,
    '--worktree-sidebar-border': border,
    '--worktree-sidebar-ring': ring,
    // Why: older worktree-sidebar descendants still consume the shadcn sidebar
    // token family; mirror it inside this scoped root so every left-sidebar
    // surface follows the selected appearance.
    '--sidebar': background,
    '--sidebar-foreground': foreground,
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': foreground,
    '--sidebar-border': border,
    '--sidebar-ring': ring
  }
  if (overrideTextTokens) {
    vars['--background'] = background
    vars['--foreground'] = foreground
    vars['--card'] = `color-mix(in srgb, ${foreground} 4%, ${background})`
    vars['--card-foreground'] = foreground
    vars['--accent'] = `color-mix(in srgb, ${foreground} 9%, ${background})`
    vars['--accent-foreground'] = foreground
    vars['--muted'] = `color-mix(in srgb, ${foreground} 7%, ${background})`
    vars['--muted-foreground'] = `color-mix(in srgb, ${foreground} 62%, ${background})`
    vars['--border'] = `color-mix(in srgb, ${foreground} 14%, ${background})`
  }
  return vars
}

function resolveTerminalSurfaceVariables(
  settings: LeftSidebarAppearanceSettings,
  systemPrefersDark: boolean
): LeftSidebarStyleVariables {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const background = applyAlpha(
    settings.terminalColorOverrides?.background ?? appearance.theme?.background ?? '#000000',
    settings.terminalBackgroundOpacity
  )
  const foreground =
    settings.terminalColorOverrides?.foreground ?? appearance.theme?.foreground ?? '#fafafa'
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
