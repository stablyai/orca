import type { XlsxThemePalette } from './xlsx-theme-palette'

/** The attributes a SpreadsheetML `<color>`, `<fgColor>` or `<bgColor>` carries. */
export type XlsxColorAttributes = {
  rgb?: string
  theme?: string
  indexed?: string
  tint?: string
}

// Why: the legacy 56-entry palette an `indexed` colour refers to. Files written
// by older tools and by several libraries still use it, and without the table
// every colour in them would silently disappear.
const INDEXED_PALETTE = [
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '800000',
  '008000',
  '000080',
  '808000',
  '800080',
  '008080',
  'C0C0C0',
  '808080',
  '9999FF',
  '993366',
  'FFFFCC',
  'CCFFFF',
  '660066',
  'FF8080',
  '0066CC',
  'CCCCFF',
  '000080',
  'FF00FF',
  'FFFF00',
  '00FFFF',
  '800080',
  '800000',
  '008080',
  '0000FF',
  '00CCFF',
  'CCFFFF',
  'CCFFCC',
  'FFFF99',
  '99CCFF',
  'FF99CC',
  'CC99FF',
  'FFCC99',
  '3366FF',
  '33CCCC',
  '99CC00',
  'FFCC00',
  'FF9900',
  'FF6600',
  '666699',
  '969696',
  '003366',
  '339966',
  '003300',
  '333300',
  '993300',
  '993366',
  '333399',
  '333333'
] as const
// Why: 64 and 65 are the system foreground and background, not palette entries.
// Resolving them to black or white would fight the app theme, so they resolve to
// nothing and the cell keeps the theme's own colours.
const SYSTEM_INDEXED_COLORS = new Set([64, 65])

/**
 * Resolves a colour to a `#rrggbb` string, or null when it carries no usable
 * colour (absent, automatic, or themed with no theme available).
 */
export function resolveXlsxColor(
  attributes: XlsxColorAttributes,
  themePalette: XlsxThemePalette
): string | null {
  const base = resolveBaseColor(attributes, themePalette)
  if (base === null) {
    return null
  }
  const tint = Number.parseFloat(attributes.tint ?? '')
  return Number.isFinite(tint) && tint !== 0 ? applyXlsxColorTint(base, tint) : base
}

function resolveBaseColor(
  attributes: XlsxColorAttributes,
  themePalette: XlsxThemePalette
): string | null {
  if (attributes.rgb !== undefined) {
    return normalizeArgb(attributes.rgb)
  }
  if (attributes.theme !== undefined) {
    const themeIndex = Number.parseInt(attributes.theme, 10)
    const themeColor = Number.isInteger(themeIndex) ? themePalette[themeIndex] : undefined
    return themeColor === undefined ? null : normalizeArgb(themeColor)
  }
  if (attributes.indexed !== undefined) {
    const indexedValue = Number.parseInt(attributes.indexed, 10)
    if (!Number.isInteger(indexedValue) || SYSTEM_INDEXED_COLORS.has(indexedValue)) {
      return null
    }
    const indexedColor = INDEXED_PALETTE[indexedValue]
    return indexedColor === undefined ? null : `#${indexedColor.toLowerCase()}`
  }
  return null
}

// Why: a `<a:schemeClr>` names a theme slot instead of indexing it, and the names
// do not follow the palette's index order — `tx1` is the body text colour, which
// lives where `dk1` was declared. This is the mapping from name to theme index.
const SCHEME_COLOR_INDEXES: Record<string, number> = {
  lt1: 0,
  bg1: 0,
  dk1: 1,
  tx1: 1,
  lt2: 2,
  bg2: 2,
  dk2: 3,
  tx2: 3,
  accent1: 4,
  accent2: 5,
  accent3: 6,
  accent4: 7,
  accent5: 8,
  accent6: 9,
  hlink: 10,
  folHlink: 11
}

/** Resolves a named theme slot, e.g. the `accent1` a chart series defaults to. */
export function resolveXlsxSchemeColor(
  schemeName: string,
  themePalette: XlsxThemePalette
): string | null {
  const themeIndex = SCHEME_COLOR_INDEXES[schemeName]
  if (themeIndex === undefined) {
    return null
  }
  const color = themePalette[themeIndex]
  return color === undefined ? null : (normalizeArgb(color) ?? null)
}

/**
 * Drops the alpha byte of an `AARRGGBB` value and normalizes to `#rrggbb`.
 *
 * Why alpha is dropped: Excel writes `FF` for every opaque fill, and a partly
 * transparent cell colour would blend with the app surface rather than showing
 * what the workbook stores.
 */
function normalizeArgb(value: string): string | null {
  const hex = value.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return null
  }
  if (hex.length === 8) {
    return `#${hex.slice(2).toLowerCase()}`
  }
  if (hex.length === 6) {
    return `#${hex.toLowerCase()}`
  }
  return null
}

/**
 * Applies a SpreadsheetML tint: a positive tint moves the colour toward white
 * and a negative one toward black, scaling luminance rather than each channel,
 * which is what Excel's own palette shades do.
 */
export function applyXlsxColorTint(color: string, tint: number): string {
  const rgb = readRgbChannels(color)
  if (rgb === null) {
    return color
  }
  const { hue, saturation, luminance } = rgbToHsl(rgb)
  const clampedTint = Math.min(1, Math.max(-1, tint))
  const tintedLuminance =
    clampedTint < 0 ? luminance * (1 + clampedTint) : luminance * (1 - clampedTint) + clampedTint
  return hslToHex({ hue, saturation, luminance: tintedLuminance })
}

type RgbChannels = { red: number; green: number; blue: number }
type HslChannels = { hue: number; saturation: number; luminance: number }

/** Channel values in 0..1, or null when the input is not a `#rrggbb` colour. */
export function readRgbChannels(color: string): RgbChannels | null {
  const hex = color.trim().replace(/^#/, '')
  if (hex.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null
  }
  return {
    red: Number.parseInt(hex.slice(0, 2), 16) / 255,
    green: Number.parseInt(hex.slice(2, 4), 16) / 255,
    blue: Number.parseInt(hex.slice(4, 6), 16) / 255
  }
}

function rgbToHsl({ red, green, blue }: RgbChannels): HslChannels {
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const luminance = (max + min) / 2
  if (max === min) {
    return { hue: 0, saturation: 0, luminance }
  }

  const delta = max - min
  const saturation = luminance > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue: number
  if (max === red) {
    hue = (green - blue) / delta + (green < blue ? 6 : 0)
  } else if (max === green) {
    hue = (blue - red) / delta + 2
  } else {
    hue = (red - green) / delta + 4
  }
  return { hue: hue / 6, saturation, luminance }
}

function hslToHex({ hue, saturation, luminance }: HslChannels): string {
  const clampedLuminance = Math.min(1, Math.max(0, luminance))
  if (saturation === 0) {
    return toHex({ red: clampedLuminance, green: clampedLuminance, blue: clampedLuminance })
  }
  const upper =
    clampedLuminance < 0.5
      ? clampedLuminance * (1 + saturation)
      : clampedLuminance + saturation - clampedLuminance * saturation
  const lower = 2 * clampedLuminance - upper
  return toHex({
    red: hueToChannel(lower, upper, hue + 1 / 3),
    green: hueToChannel(lower, upper, hue),
    blue: hueToChannel(lower, upper, hue - 1 / 3)
  })
}

function hueToChannel(lower: number, upper: number, hue: number): number {
  const wrapped = hue < 0 ? hue + 1 : hue > 1 ? hue - 1 : hue
  if (wrapped < 1 / 6) {
    return lower + (upper - lower) * 6 * wrapped
  }
  if (wrapped < 1 / 2) {
    return upper
  }
  if (wrapped < 2 / 3) {
    return lower + (upper - lower) * (2 / 3 - wrapped) * 6
  }
  return lower
}

function toHex({ red, green, blue }: RgbChannels): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}
