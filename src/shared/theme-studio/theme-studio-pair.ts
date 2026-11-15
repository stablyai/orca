import {
  formatThemeColor,
  oklchToRgba,
  parseThemeColor,
  rgbaToOklch
} from '../color/oklch-color-transform'
import { TERMINAL_COLOR_KEYS } from '../terminal-themes/terminal-custom-themes'
import {
  cloneThemeStudioVariant,
  type ThemeStudioMode,
  type ThemeStudioVariant
} from './theme-studio-draft'

// Why a curve, not 1 - L: dark themes keep surfaces between 0.1 and 0.4 and text above 0.6;
// light ones keep surfaces above 0.85 and text below 0.6. Strictly decreasing, so neighbors stay
// apart (a light background and its cards stay distinct), and toDark undoes toLight exactly.
const DARK_TO_LIGHT: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.12, 0.995],
  [0.25, 0.96],
  [0.4, 0.9],
  [0.55, 0.55],
  [0.7, 0.42],
  [0.85, 0.28],
  [1, 0.12]
]
const LIGHT_TO_DARK = DARK_TO_LIGHT.map(([from, to]) => [to, from] as const).sort(
  (left, right) => left[0] - right[0]
)

function along(points: readonly (readonly [number, number])[], l: number): number {
  const clamped = Math.min(1, Math.max(0, l))
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index]
    const [x0, y0] = points[index - 1]
    if (clamped <= x1) {
      return x1 === x0 ? y1 : y0 + ((clamped - x0) / (x1 - x0)) * (y1 - y0)
    }
  }
  return points.at(-1)?.[1] ?? clamped
}

const toLight = (l: number): number => along(DARK_TO_LIGHT, l)
const toDark = (l: number): number => along(LIGHT_TO_DARK, l)

/**
 * The same color for the other mode: OKLCH lightness mirrored along that curve (dark surfaces
 * become light ones, light text dark text), hue, chroma and alpha kept, so the pair reads as one
 * theme. `band` limits where it lands. Null when the value is not a color this can read.
 */
export function mirrorThemeColor(
  value: string,
  target: ThemeStudioMode,
  band: readonly [number, number] = [0.04, 0.995]
): string | null {
  const color = parseThemeColor(value)
  if (!color) {
    return null
  }
  const oklch = rgbaToOklch(color)
  const mirrored = target === 'light' ? toLight(oklch.l) : toDark(oklch.l)
  const l = Math.min(band[1], Math.max(band[0], mirrored))
  return formatThemeColor(oklchToRgba({ ...oklch, l }))
}

// Why kept: ANSI black and white name ends of the scale, not surfaces; a light theme's black is
// still dark. The colored ANSI entries land in a band that reads on the other mode's background.
const ANSI_KEPT = new Set(['black', 'brightBlack', 'white', 'brightWhite'])
const ANSI_SURFACE_KEYS = new Set([
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground'
])
const ANSI_BAND: Record<ThemeStudioMode, readonly [number, number]> = {
  light: [0.4, 0.62],
  dark: [0.66, 0.86]
}

/** The other mode's variant derived from `source`, with every token, terminal color and syntax
 *  color mirrored; values it cannot read are kept as they are and listed. */
export function pairThemeStudioVariant(
  source: ThemeStudioVariant,
  target: ThemeStudioMode
): {
  variant: ThemeStudioVariant
  kept: string[]
} {
  const next = cloneThemeStudioVariant(source)
  const kept: string[] = []
  const mirror = (key: string, value: string, band?: readonly [number, number]): string => {
    const mirrored = mirrorThemeColor(value, target, band)
    if (mirrored === null) {
      kept.push(key)
      return value
    }
    return mirrored
  }
  for (const [token, value] of Object.entries(next.tokens)) {
    next.tokens[token] = mirror(token, value)
  }
  if (next.terminal) {
    for (const key of TERMINAL_COLOR_KEYS) {
      const value = next.terminal[key]
      if (value && !ANSI_KEPT.has(key)) {
        next.terminal[key] = mirror(
          `terminal.${key}`,
          value,
          ANSI_SURFACE_KEYS.has(key) ? undefined : ANSI_BAND[target]
        )
      }
    }
  }
  next.tokenColors?.forEach((rule, index) => {
    if (rule.settings.foreground) {
      rule.settings.foreground = mirror(`tokenColors.${index}`, rule.settings.foreground)
    }
  })
  return { variant: next, kept }
}

export const otherThemeStudioMode = (mode: ThemeStudioMode): ThemeStudioMode =>
  mode === 'dark' ? 'light' : 'dark'
