import {
  formatThemeColor,
  oklchToRgba,
  parseThemeColor,
  rgbaToOklch
} from '../color/oklch-color-transform'
import type { ThemeStudioVariant } from './theme-studio-draft'

/** Surfaces that move together when a request names an area ("sidebar more distinct"). */
export const THEME_STUDIO_SEPARATE_SCOPES = {
  sidebar: [
    '--sidebar',
    '--worktree-sidebar',
    '--sidebar-accent',
    '--worktree-sidebar-accent',
    '--worktree-sidebar-active'
  ],
  tabs: ['--tab-bar', '--tab-inactive', '--tab-active'],
  cards: ['--card', '--popover'],
  editor: ['--editor-surface']
} as const satisfies Record<string, readonly string[]>

export type ThemeStudioSeparateScope = keyof typeof THEME_STUDIO_SEPARATE_SCOPES

export const THEME_STUDIO_SEPARATE_SCOPE_NAMES = [
  'sidebar',
  'tabs',
  'cards',
  'editor'
] as const satisfies readonly ThemeStudioSeparateScope[]

/**
 * Steps an area's surfaces `amount` of OKLCH lightness away from the canvas, keeping hue and
 * chroma; a negative amount brings them closer. Text on them is left to the contrast fixes.
 */
export function separateThemeStudioVariant(
  variant: ThemeStudioVariant,
  scope: ThemeStudioSeparateScope,
  amount: number
): { variant: ThemeStudioVariant; changed: string[] } {
  const canvas = parseThemeColor(variant.tokens['--background'] ?? '')
  const canvasLightness = canvas ? rgbaToOklch(canvas).l : 0
  const tokens = { ...variant.tokens }
  const changed: string[] = []
  for (const token of THEME_STUDIO_SEPARATE_SCOPES[scope]) {
    const color = tokens[token] ? parseThemeColor(tokens[token]) : null
    if (!color) {
      continue
    }
    const oklch = rgbaToOklch(color)
    // Why the canvas side: a surface equal to the canvas steps toward the middle, where it shows.
    const away =
      oklch.l === canvasLightness
        ? canvasLightness < 0.5
          ? 1
          : -1
        : Math.sign(oklch.l - canvasLightness)
    const next = formatThemeColor(oklchToRgba({ ...oklch, l: oklch.l + away * amount }))
    if (next !== tokens[token].toLowerCase()) {
      tokens[token] = next
      changed.push(token)
    }
  }
  return { variant: { ...variant, tokens }, changed }
}
