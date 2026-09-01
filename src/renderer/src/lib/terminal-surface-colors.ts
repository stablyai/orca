import type { GlobalSettings } from '../../../shared/global-settings-types'
import { HEX_COLOR_RE } from '../../../shared/color-validation'
import { resolveEffectiveTerminalAppearance } from './terminal-theme'

export type TerminalSurfaceSettings = Pick<
  GlobalSettings,
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

export type TerminalSurfaceColors = {
  background: string
  foreground: string
}

export type SurfaceStyleVariables = Record<string, string>

/** `#rgb` / `#rrggbb` to `rgba()` with the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.trim().replace('#', '')
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

/** Applies the terminal background opacity to a hex color; other formats pass through unchanged. */
function applyAlpha(color: string, alpha: number | undefined): string {
  if (alpha === undefined || alpha >= 1 || !HEX_COLOR_RE.test(color.trim())) {
    return color
  }
  return hexToRgba(color, Math.min(1, Math.max(0, alpha)))
}

/** Background/foreground of the active terminal theme, with color overrides and background opacity applied. */
export function resolveTerminalSurfaceColors(
  settings: TerminalSurfaceSettings,
  systemPrefersDark: boolean
): TerminalSurfaceColors {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const background = applyAlpha(
    settings.terminalColorOverrides?.background ?? appearance.theme?.background ?? '#000000',
    settings.terminalBackgroundOpacity
  )
  const foreground =
    settings.terminalColorOverrides?.foreground ?? appearance.theme?.foreground ?? '#fafafa'
  return { background, foreground }
}

/** Re-derives the shadcn text/surface token family from a terminal color pair so chrome scoped
 *  under it keeps readable contrast regardless of the app theme. Mix ratios match the global
 *  tokens (7% border, #5906). */
export function buildSurfaceTextTokenVariables({
  background,
  foreground
}: TerminalSurfaceColors): SurfaceStyleVariables {
  return {
    '--background': background,
    '--foreground': foreground,
    '--card': `color-mix(in srgb, ${foreground} 4%, ${background})`,
    '--card-foreground': foreground,
    '--accent': `color-mix(in srgb, ${foreground} 9%, ${background})`,
    '--accent-foreground': foreground,
    '--muted': `color-mix(in srgb, ${foreground} 7%, ${background})`,
    '--muted-foreground': `color-mix(in srgb, ${foreground} 62%, ${background})`,
    '--border': `color-mix(in srgb, ${foreground} 7%, ${background})`,
    '--popover': `color-mix(in srgb, ${foreground} 4%, ${background})`,
    '--popover-foreground': foreground,
    '--secondary': `color-mix(in srgb, ${foreground} 7%, ${background})`,
    '--secondary-foreground': foreground,
    '--input': `color-mix(in srgb, ${foreground} 12%, ${background})`,
    '--ring': `color-mix(in srgb, ${foreground} 44%, ${background})`
  }
}

/** The shadcn sidebar token family plus Orca's worktree-sidebar mirror, derived from one color pair. */
export function buildSidebarTokenVariables({
  background,
  foreground
}: TerminalSurfaceColors): SurfaceStyleVariables {
  const accent = `color-mix(in srgb, ${foreground} 9%, ${background})`
  // 7% keeps the sidebar divider at the same prominence as the global --border (#5906).
  const border = `color-mix(in srgb, ${foreground} 7%, ${background})`
  const ring = `color-mix(in srgb, ${foreground} 44%, ${background})`
  return {
    '--worktree-sidebar': background,
    '--worktree-sidebar-foreground': foreground,
    '--worktree-sidebar-accent': accent,
    '--worktree-sidebar-accent-foreground': foreground,
    '--worktree-sidebar-border': border,
    '--worktree-sidebar-ring': ring,
    // Why: older worktree-sidebar descendants still consume the shadcn sidebar token family.
    '--sidebar': background,
    '--sidebar-foreground': foreground,
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': foreground,
    '--sidebar-border': border,
    '--sidebar-ring': ring
  }
}
