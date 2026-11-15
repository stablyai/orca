import { rgbaToHex, type Rgba } from './rgba-contrast'

/** Perceptual lightness 0-1, chroma 0-~0.4, hue in degrees, alpha 0-1. */
export type Oklch = { l: number; c: number; h: number; alpha: number }

/** Theme-wide edits, all optional; percentages are relative (`10` is 10% more). */
export type ThemeColorAdjustment = {
  /** -100 (cooler, toward blue) to 100 (warmer, toward amber). */
  warmth?: number
  hue?: number
  saturation?: number
  lightness?: number
  /** Pushes lightness away from (positive) or toward (negative) the surface it sits on. */
  contrast?: number
}

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`
const FUNCTION_PATTERN = /^(rgba?|hsla?|oklch|oklab)\(\s*([^()]*)\)$/i

function hexColor(value: string): Rgba | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)
  if (!match) {
    return null
  }
  const digits =
    match[1].length <= 4
      ? match[1]
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : match[1]
  const channel = (index: number): number => Number.parseInt(digits.slice(index, index + 2), 16)
  return [channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) / 255 : 1]
}

/** A CSS number or percentage; `percentOf` is what 100% means. */
function component(raw: string, percentOf: number): number | null {
  const match = new RegExp(`^(${NUMBER})(%?)$`, 'i').exec(raw)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return match[2] ? (value / 100) * percentOf : value
}

function angle(raw: string): number | null {
  const match = new RegExp(`^(${NUMBER})(deg|turn|rad|grad)?$`, 'i').exec(raw)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  switch (match[2]?.toLowerCase()) {
    case 'turn':
      return value * 360
    case 'rad':
      return (value * 180) / Math.PI
    case 'grad':
      return value * 0.9
    default:
      return value
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - chroma / 2
  const [r, g, b] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** Parses hex, rgb(), hsl(), oklch() and oklab(); null for anything else (names, color-mix). */
export function parseThemeColor(input: string): Rgba | null {
  const value = input.trim()
  const hex = hexColor(value)
  if (hex) {
    return hex
  }
  const match = FUNCTION_PATTERN.exec(value)
  if (!match) {
    return null
  }
  const kind = match[1].toLowerCase()
  const [body, alphaPart] = match[2].split('/').map((part) => part.trim())
  const parts = body.includes(',')
    ? body.split(',').map((part) => part.trim())
    : body.split(/\s+/).filter(Boolean)
  const alphaRaw = alphaPart ?? (parts.length === 4 ? parts.pop() : undefined)
  const alpha = alphaRaw === undefined ? 1 : component(alphaRaw, 1)
  if (parts.length !== 3 || alpha === null) {
    return null
  }
  const [first, second, third] = parts
  let rgb: [number, number, number] | null = null
  if (kind.startsWith('rgb')) {
    const r = component(first, 255)
    const g = component(second, 255)
    const b = component(third, 255)
    rgb = r === null || g === null || b === null ? null : [r, g, b]
  } else if (kind.startsWith('hsl')) {
    const h = angle(first)
    const s = component(second.endsWith('%') ? second : `${second}%`, 1)
    const l = component(third.endsWith('%') ? third : `${third}%`, 1)
    rgb =
      h === null || s === null || l === null ? null : hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1))
  } else {
    const l = component(first, 1)
    const isLch = kind === 'oklch'
    const a = component(second, 0.4)
    const bOrHue = isLch ? angle(third) : component(third, 0.4)
    if (l !== null && a !== null && bOrHue !== null) {
      const lab = isLch
        ? {
            l,
            a: a * Math.cos((bOrHue * Math.PI) / 180),
            b: a * Math.sin((bOrHue * Math.PI) / 180)
          }
        : { l, a, b: bOrHue }
      rgb = oklabToRgb(lab.l, lab.a, lab.b)
    }
  }
  return rgb
    ? [clamp(rgb[0], 0, 255), clamp(rgb[1], 0, 255), clamp(rgb[2], 0, 255), clamp(alpha, 0, 1)]
    : null
}

const toLinear = (channel: number): number => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const fromLinear = (channel: number): number =>
  255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055)

export function rgbToOklab([r, g, b]: Rgba): { l: number; a: number; b: number } {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

/** Unclamped sRGB 0-255; out-of-gamut channels fall outside the range. */
function oklabToRgb(lightness: number, a: number, b: number): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ]
}

export function rgbaToOklch(color: Rgba): Oklch {
  const { l, a, b } = rgbToOklab(color)
  const hue = (Math.atan2(b, a) * 180) / Math.PI
  return { l, c: Math.hypot(a, b), h: (hue + 360) % 360, alpha: color[3] }
}

const inGamut = (rgb: readonly number[]): boolean =>
  rgb.every((channel) => channel >= -0.5 && channel <= 255.5)

/** Back to sRGB, lowering chroma (keeping lightness and hue) until it fits. */
export function oklchToRgba({ l, c, h, alpha }: Oklch): Rgba {
  const lightness = clamp(l, 0, 1)
  const radians = (h * Math.PI) / 180
  const at = (chroma: number): [number, number, number] =>
    oklabToRgb(lightness, chroma * Math.cos(radians), chroma * Math.sin(radians))
  let low = 0
  let high = Math.max(0, c)
  let rgb = at(high)
  if (!inGamut(rgb)) {
    for (let step = 0; step < 24; step += 1) {
      const mid = (low + high) / 2
      if (inGamut(at(mid))) {
        low = mid
      } else {
        high = mid
      }
    }
    rgb = at(low)
  }
  return [clamp(rgb[0], 0, 255), clamp(rgb[1], 0, 255), clamp(rgb[2], 0, 255), clamp(alpha, 0, 1)]
}

/** `#rrggbb`, or `#rrggbbaa` when translucent. */
export function formatThemeColor(color: Rgba): string {
  const alpha = Math.round(clamp(color[3], 0, 1) * 255)
  return alpha === 255
    ? rgbaToHex(color)
    : `${rgbaToHex(color)}${alpha.toString(16).padStart(2, '0')}`
}

// Why these hues: OKLCH amber and sky blue read as "warm" and "cool" on both light and dark grounds.
const WARM_HUE = 65
const COOL_HUE = 245
const MAX_WARMTH_ROTATION = 30
const MAX_WARMTH_TINT = 0.025
const NEUTRAL_CHROMA = 0.03

const MAX_ROTATED_HUE_DISTANCE = 90

const signedHueDelta = (from: number, to: number): number => ((to - from + 540) % 360) - 180
const hueDistance = (from: number, to: number): number => Math.abs(signedHueDelta(from, to))

function rotateToward(hue: number, target: number, maxDegrees: number): number {
  const delta = signedHueDelta(hue, target)
  return hue + Math.sign(delta) * Math.min(Math.abs(delta), maxDegrees)
}

/** The lightness `contrast` pushes away from: the canvas a color is read against. */
const MIDDLE_LIGHTNESS = 0.5

function adjustOklch(
  color: Oklch,
  adjustment: ThemeColorAdjustment,
  anchorLightness: number
): Oklch {
  let { l, c, h } = color
  if (adjustment.hue) {
    h += adjustment.hue
  }
  if (adjustment.saturation) {
    c *= Math.max(0, 1 + adjustment.saturation / 100)
  }
  if (adjustment.lightness) {
    const amount = adjustment.lightness / 100
    l += amount > 0 ? (1 - l) * amount : l * amount
  }
  if (adjustment.contrast) {
    l = anchorLightness + (l - anchorLightness) * Math.max(0, 1 + adjustment.contrast / 100)
  }
  if (adjustment.warmth) {
    const strength = clamp(Math.abs(adjustment.warmth), 0, 100) / 100
    const target = adjustment.warmth > 0 ? WARM_HUE : COOL_HUE
    // Why only near hues: turning a far hue (blue toward amber) passes through purple or green.
    if (c >= NEUTRAL_CHROMA && hueDistance(h, target) <= MAX_ROTATED_HUE_DISTANCE) {
      h = rotateToward(h, target, MAX_WARMTH_ROTATION * strength)
    }
    // Why a tint for every color: greys have no hue to rotate, and they carry most of a theme.
    const radians = (h * Math.PI) / 180
    const tint = MAX_WARMTH_TINT * strength
    const a = c * Math.cos(radians) + tint * Math.cos((target * Math.PI) / 180)
    const b = c * Math.sin(radians) + tint * Math.sin((target * Math.PI) / 180)
    c = Math.hypot(a, b)
    h = (Math.atan2(b, a) * 180) / Math.PI
  }
  return { l: clamp(l, 0, 1), c, h: ((h % 360) + 360) % 360, alpha: color.alpha }
}

/** OKLCH lightness of a color, or the middle when it cannot be read. */
export function themeColorLightness(value: string | undefined): number {
  const color = value ? parseThemeColor(value) : null
  return color ? rgbaToOklch(color).l : MIDDLE_LIGHTNESS
}

/** The adjusted color as hex, or null when the value is not a color this can read. `canvas` is
 *  what the color is read against; `contrast` moves it away from the canvas's lightness. */
export function adjustThemeColor(
  value: string,
  adjustment: ThemeColorAdjustment,
  canvas?: string
): string | null {
  const color = parseThemeColor(value)
  return color
    ? formatThemeColor(
        oklchToRgba(adjustOklch(rgbaToOklch(color), adjustment, themeColorLightness(canvas)))
      )
    : null
}
