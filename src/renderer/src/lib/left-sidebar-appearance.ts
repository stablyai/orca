import type { CSSProperties } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  normalizeLeftSidebarTintColor,
  normalizeLeftSidebarTintOpacity
} from '../../../shared/left-sidebar-appearance'
import { pluginAppThemeCssFallback } from '../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'
import { hostPillOutlineMixOver, mix, type ColorProbe, type Rgba } from './plugin-theme-tokens'

type LeftSidebarAppearanceSettings = Pick<
  GlobalSettings,
  'leftSidebarAppearanceMode' | 'leftSidebarTintColor' | 'leftSidebarTintOpacity'
>

/** Custom properties for a style prop; React's CSSProperties omits `--*` keys. */
export type LeftSidebarStyleVariables = CSSProperties & Record<`--${string}`, string>

/** Root variable holding the host pill outline mix measured for the tinted sidebar's colors. */
export const TINTED_HOST_PILL_OUTLINE_MIX_TOKEN = '--worktree-tinted-host-pill-outline-mix'

function buildTintedSurfaceVariables(background: string): LeftSidebarStyleVariables {
  const foreground = 'var(--foreground)'
  const accent = `color-mix(in srgb, ${foreground} 9%, ${background})`
  // Match global dark --border at 7%; the old 14% sidebar divider was too bright (#5906).
  const border = `color-mix(in srgb, ${foreground} 7%, ${background})`
  const ring = `color-mix(in srgb, ${foreground} 44%, ${background})`
  return {
    '--worktree-sidebar': background,
    '--worktree-sidebar-foreground': foreground,
    '--worktree-sidebar-accent': accent,
    '--worktree-sidebar-accent-foreground': foreground,
    '--worktree-sidebar-border': border,
    '--worktree-sidebar-ring': ring,
    // Mirror shadcn sidebar tokens inside this root for older descendants to follow the chosen appearance.
    '--sidebar': background,
    '--sidebar-foreground': foreground,
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': foreground,
    '--sidebar-border': border,
    '--sidebar-ring': ring,
    // Why `initial`: the chosen appearance owns this subtree, so a plugin theme's row colors yield
    // to each consumer's built-in fallback derived from the tokens above.
    '--worktree-sidebar-active': 'initial',
    '--worktree-sidebar-active-border': 'initial',
    // Why not the theme's mix: it was measured on the theme's sidebar, not this tint.
    '--worktree-host-pill-outline-mix': `var(${TINTED_HOST_PILL_OUTLINE_MIX_TOKEN}, 40%)`
  }
}

/** Style variables for the tinted left sidebar; undefined in every other mode. */
export function resolveLeftSidebarStyleVariables(
  settings: LeftSidebarAppearanceSettings | null | undefined
): LeftSidebarStyleVariables | undefined {
  if (settings?.leftSidebarAppearanceMode !== 'tinted') {
    return undefined
  }
  const tintColor = normalizeLeftSidebarTintColor(settings.leftSidebarTintColor)
  const tintOpacity = normalizeLeftSidebarTintOpacity(settings.leftSidebarTintOpacity)
  const tintPercent = Number((tintOpacity * 100).toFixed(2))
  return buildTintedSurfaceVariables(
    `color-mix(in srgb, ${tintColor} ${tintPercent}%, var(--background))`
  )
}

/**
 * The host pill outline mix for the tinted sidebar, measured on the colors it paints: the app's
 * text on the tint mixed into the app background, under the built-in selected wash. Null in every
 * other mode, or when a color can't be resolved.
 */
export function tintedSidebarHostPillOutlineMix(
  settings: LeftSidebarAppearanceSettings | null | undefined,
  app: { foreground: string; background: string; base: 'light' | 'dark' },
  probe: ColorProbe
): number | null {
  if (settings?.leftSidebarAppearanceMode !== 'tinted') {
    return null
  }
  const foreground = probe(app.foreground)
  const background = probe(app.background)
  const tint = probe(normalizeLeftSidebarTintColor(settings.leftSidebarTintColor))
  const washRule = pluginAppThemeCssFallback('--worktree-sidebar-active', app.base)
  if (!foreground || !background || !tint || !washRule || !('tint' in washRule)) {
    return null
  }
  const opacity = normalizeLeftSidebarTintOpacity(settings.leftSidebarTintOpacity)
  const sidebar = mix(tint, background, opacity * 100)
  const wash: Rgba = [foreground[0], foreground[1], foreground[2], washRule.percent / 100]
  return hostPillOutlineMixOver(foreground, sidebar, wash)
}
