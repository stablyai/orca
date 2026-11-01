import type { CSSProperties } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  normalizeLeftSidebarTintColor,
  normalizeLeftSidebarTintOpacity
} from '../../../shared/left-sidebar-appearance'

type LeftSidebarAppearanceSettings = Pick<
  GlobalSettings,
  'leftSidebarAppearanceMode' | 'leftSidebarTintColor' | 'leftSidebarTintOpacity'
>

/** Custom properties for a style prop; React's CSSProperties omits `--*` keys. */
export type LeftSidebarStyleVariables = CSSProperties & Record<`--${string}`, string>

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
    '--worktree-sidebar-active-border': 'initial'
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
