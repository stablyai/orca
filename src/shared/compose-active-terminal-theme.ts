import type { ITheme } from '@xterm/xterm'
import { HEX_COLOR_RE } from './color-validation'
import type { GlobalSettings } from './types'

export function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value)
}

// Why extracted: lets the settings preview compose the same theme without depending on PaneManager. Keep pure.
export function composeActiveTerminalTheme(
  baseTheme: ITheme | null,
  settings: Pick<
    GlobalSettings,
    'terminalColorOverrides' | 'terminalBackgroundOpacity' | 'terminalCursorOpacity'
  >
): ITheme | null {
  if (!baseTheme) {
    return null
  }
  // Why transparent ruler border: scrollbar.width enables xterm's overview ruler, whose border would paint a bright line.
  // Why raised slider alpha: xterm's default (~0.2) is nearly invisible on dark bg. Before the spread so explicit theme wins.
  let theme: ITheme = {
    overviewRulerBorder: 'transparent',
    scrollbarSliderBackground: 'rgba(180, 180, 185, 0.4)',
    scrollbarSliderHoverBackground: 'rgba(180, 180, 185, 0.6)',
    scrollbarSliderActiveBackground: 'rgba(180, 180, 185, 0.8)',
    ...baseTheme
  }
  // Why: merge Ghostty color overrides atop the base theme so individual colors can be tweaked without losing the rest.
  if (settings.terminalColorOverrides) {
    theme = { ...theme, ...settings.terminalColorOverrides }
  }
  // Why: convert the hex background to rgba so xterm honors the opacity when allowTransparency is set.
  if (settings.terminalBackgroundOpacity !== undefined && theme.background) {
    theme = {
      ...theme,
      background: hexToRgba(theme.background, settings.terminalBackgroundOpacity)
    }
  }
  // Why hex-only: hexToRgba expects a hex input, so named CSS cursor colors are left untouched.
  if (settings.terminalCursorOpacity !== undefined && theme.cursor && isHexColor(theme.cursor)) {
    theme = {
      ...theme,
      cursor: hexToRgba(theme.cursor, settings.terminalCursorOpacity)
    }
  }
  return theme
}

/** Value equality over composed ITheme objects (flat string slots plus the extendedAnsi array); gates the options.theme write. */
export function composedTerminalThemesEqual(a: ITheme | undefined, b: ITheme): boolean {
  if (!a) {
    return false
  }
  if (a === b) {
    return true
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (key === 'extendedAnsi') {
      continue
    }
    if (a[key as keyof ITheme] !== b[key as keyof ITheme]) {
      return false
    }
  }
  const extA = a.extendedAnsi
  const extB = b.extendedAnsi
  if (!extA || !extB) {
    return extA === extB
  }
  return extA.length === extB.length && extA.every((value, i) => value === extB[i])
}
