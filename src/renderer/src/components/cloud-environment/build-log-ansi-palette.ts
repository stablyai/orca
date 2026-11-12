import type { ITheme } from '@xterm/xterm'
import { getTheme } from '@/lib/terminal/appearance/terminal-themes-data'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT
} from '../../../../shared/terminal-themes/terminal-theme-selection'
import { readableOn, rgbaToHex, type Rgba } from '../../../../shared/color/rgba-contrast'

/** WCAG AA for body text; the log is 12px mono, so the large-text 3:1 floor does not apply. */
export const MIN_ANSI_CONTRAST = 4.5

const ANSI_PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const satisfies readonly (keyof ITheme)[]

/** Opaque log surfaces per theme: the log body (BuildLogViewer: bg-muted/30 over card, or
 *  dark:bg-black/25 over card), the row hover wash, and the error-row tint. */
export const LOG_SURFACES: Record<'dark' | 'light', readonly Rgba[]> = {
  light: [
    [252, 252, 252, 1],
    [242, 242, 242, 1],
    [252, 236, 236, 1]
  ],
  dark: [
    [17, 17, 17, 1],
    [27, 27, 27, 1],
    [42, 22, 24, 1]
  ]
}

function hexToRgba(hex: string): Rgba | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) {
    return null
  }
  const digits = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1]
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16))
  return [r, g, b, 1]
}

/** Terminal palettes are tuned for a terminal background, not the log's muted surface; push
 *  each color toward black (light) or white (dark), keeping its hue, until it clears AA. */
export function clampAnsiPalette(
  palette: readonly (string | undefined)[],
  theme: 'dark' | 'light'
): (string | undefined)[] {
  return palette.map((color) => {
    const rgba = color ? hexToRgba(color) : null
    if (!rgba) {
      return color
    }
    return rgbaToHex(readableOn(rgba, LOG_SURFACES[theme], theme === 'light', MIN_ANSI_CONTRAST))
  })
}

function themePalette(name: string): (string | undefined)[] {
  const theme = getTheme(name)
  return ANSI_PALETTE_KEYS.map((key) => theme?.[key])
}

/** Foregrounds are clamped; backgrounds keep the raw theme colors because the program chose
 *  that fg/bg pairing, and a clamped background would fight the text it carries. */
export const ANSI_PALETTES = {
  dark: {
    fg: clampAnsiPalette(themePalette(DEFAULT_TERMINAL_THEME_DARK), 'dark'),
    bg: themePalette(DEFAULT_TERMINAL_THEME_DARK)
  },
  light: {
    fg: clampAnsiPalette(themePalette(DEFAULT_TERMINAL_THEME_LIGHT), 'light'),
    bg: themePalette(DEFAULT_TERMINAL_THEME_LIGHT)
  }
}
