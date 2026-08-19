import type { GlobalSettings } from '../../../shared/global-settings-types'
import { HEX_COLOR_RE } from '../../../shared/color-validation'
import {
  normalizeLeftSidebarTintColor,
  normalizeLeftSidebarTintOpacity
} from '../../../shared/left-sidebar-appearance'
import { normalizeTerminalHexColor } from '../../../shared/terminal-custom-themes'
import { isTerminalBackgroundLight, resolveEffectiveTerminalAppearance } from './terminal-theme'

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

export const APP_APPEARANCE_STYLE_PROPERTIES = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input',
  '--ring',
  '--worktree-sidebar',
  '--worktree-sidebar-foreground',
  '--worktree-sidebar-primary',
  '--worktree-sidebar-primary-foreground',
  '--worktree-sidebar-accent',
  '--worktree-sidebar-accent-foreground',
  '--worktree-sidebar-border',
  '--worktree-sidebar-ring',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
  '--bg-titlebar'
] as const

function compositeWithBaseSurface(color: string, alpha: number | undefined): string {
  if (alpha === undefined || alpha >= 1 || !HEX_COLOR_RE.test(color.trim())) {
    return color
  }
  const percent = Number((Math.min(1, Math.max(0, alpha)) * 100).toFixed(2))
  return `color-mix(in srgb, ${color} ${percent}%, var(--app-appearance-base-background))`
}

function buildSurfaceVariables(background: string, foreground: string): LeftSidebarStyleVariables {
  const card = `color-mix(in srgb, ${foreground} 4%, ${background})`
  const popover = `color-mix(in srgb, ${foreground} 6%, ${background})`
  const secondary = `color-mix(in srgb, ${foreground} 12%, ${background})`
  const accent = `color-mix(in srgb, ${foreground} 9%, ${background})`
  const muted = `color-mix(in srgb, ${foreground} 7%, ${background})`
  const border = `color-mix(in srgb, ${foreground} 7%, ${background})`
  const input = `color-mix(in srgb, ${foreground} 15%, ${background})`
  const ring = `color-mix(in srgb, ${foreground} 44%, ${background})`

  return {
    '--background': background,
    '--foreground': foreground,
    '--card': card,
    '--card-foreground': foreground,
    '--popover': popover,
    '--popover-foreground': foreground,
    '--primary': foreground,
    '--primary-foreground': background,
    '--secondary': secondary,
    '--secondary-foreground': foreground,
    '--muted': muted,
    '--muted-foreground': `color-mix(in srgb, ${foreground} 62%, ${background})`,
    '--accent': accent,
    '--accent-foreground': foreground,
    '--border': border,
    '--input': input,
    '--ring': ring,
    '--worktree-sidebar': background,
    '--worktree-sidebar-foreground': foreground,
    '--worktree-sidebar-primary': foreground,
    '--worktree-sidebar-primary-foreground': background,
    '--worktree-sidebar-accent': accent,
    '--worktree-sidebar-accent-foreground': foreground,
    '--worktree-sidebar-border': border,
    '--worktree-sidebar-ring': ring,
    '--sidebar': background,
    '--sidebar-foreground': foreground,
    '--sidebar-primary': foreground,
    '--sidebar-primary-foreground': background,
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': foreground,
    '--sidebar-border': border,
    '--sidebar-ring': ring,
    '--bg-titlebar': card
  }
}

function resolveTerminalSurface(
  settings: LeftSidebarAppearanceSettings,
  systemPrefersDark: boolean
): { background: string; foreground: string; rawBackground: string } {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const rawBackground =
    normalizeTerminalHexColor(settings.terminalColorOverrides?.background) ??
    appearance.theme?.background ??
    '#000000'
  return {
    background: compositeWithBaseSurface(rawBackground, settings.terminalBackgroundOpacity),
    foreground:
      normalizeTerminalHexColor(settings.terminalColorOverrides?.foreground) ??
      appearance.theme?.foreground ??
      '#fafafa',
    rawBackground
  }
}

function resolveTerminalSurfaceVariables(
  settings: LeftSidebarAppearanceSettings,
  systemPrefersDark: boolean
): LeftSidebarStyleVariables {
  const { background, foreground } = resolveTerminalSurface(settings, systemPrefersDark)
  return buildSurfaceVariables(background, foreground)
}

function resolveTintedSurfaceVariables(
  settings: LeftSidebarAppearanceSettings
): LeftSidebarStyleVariables {
  const tintColor = normalizeLeftSidebarTintColor(settings.leftSidebarTintColor)
  const tintOpacity = normalizeLeftSidebarTintOpacity(settings.leftSidebarTintOpacity)
  const tintPercent = Number((tintOpacity * 100).toFixed(2))
  const background = `color-mix(in srgb, ${tintColor} ${tintPercent}%, var(--app-appearance-base-background))`
  return buildSurfaceVariables(background, 'var(--app-appearance-base-foreground)')
}

function resolveBaseDarkMode(
  settings: LeftSidebarAppearanceSettings,
  systemPrefersDark: boolean
): boolean {
  return settings.theme === 'dark' || (settings.theme === 'system' && systemPrefersDark)
}

export function resolveAppAppearanceDarkMode(
  settings: LeftSidebarAppearanceSettings | null | undefined,
  systemPrefersDark: boolean
): boolean | undefined {
  if (
    !settings ||
    settings.leftSidebarAppearanceMode === undefined ||
    settings.leftSidebarAppearanceMode === 'default'
  ) {
    return undefined
  }
  if (settings.leftSidebarAppearanceMode === 'tinted') {
    return resolveBaseDarkMode(settings, systemPrefersDark)
  }
  const { rawBackground } = resolveTerminalSurface(settings, systemPrefersDark)
  return !isTerminalBackgroundLight(rawBackground, {
    backgroundOpacity: settings.terminalBackgroundOpacity,
    appSurface: resolveBaseDarkMode(settings, systemPrefersDark) ? 'dark' : 'light'
  })
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
