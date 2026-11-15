import type { Rgba } from '../color/rgba-contrast'
import type { CssColorSpace, Vec3 } from './css-color-spaces'
import {
  CSS_NUMBER,
  parsedFromCoords,
  spaceOf,
  splitTopLevel,
  UNCHECKED,
  words,
  type ParsedCssColor,
  type ParseResult
} from './css-color-parse'
import { colorMix } from './css-color-mix'
import { CSS_NAMED_COLORS } from './css-named-colors'
import type { ColorProbe } from './theme-contrast-engine'

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value))
const SYSTEM_COLORS = new Set(
  'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext'.split(
    ' '
  )
)
const LEGACY_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla'])
const PREDEFINED_SPACES = new Set([
  'srgb',
  'srgb-linear',
  'display-p3',
  'rec2020',
  'a98-rgb',
  'prophoto-rgb',
  'xyz',
  'xyz-d50',
  'xyz-d65'
])

type Component = { value: number; kind: 'number' | 'percent' | 'none' }
const ONE: Component = { value: 1, kind: 'number' }

/** A number, a percentage of `percentOf`, or `none` (NaN). */
function component(raw: string, percentOf: number): Component | null {
  if (raw === 'none') {
    return { value: Number.NaN, kind: 'none' }
  }
  const percent = raw.endsWith('%')
  const text = percent ? raw.slice(0, -1) : raw
  if (!CSS_NUMBER.test(text)) {
    return null
  }
  return percent
    ? { value: (Number(text) / 100) * percentOf, kind: 'percent' }
    : { value: Number(text), kind: 'number' }
}

const DEGREES: Record<string, number> = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }

function angle(raw: string): Component | null {
  if (raw === 'none') {
    return { value: Number.NaN, kind: 'none' }
  }
  const match = /^(.*?)(deg|turn|rad|grad)?$/.exec(raw)
  if (!match || !CSS_NUMBER.test(match[1])) {
    return null
  }
  return { value: Number(match[1]) * DEGREES[match[2] ?? 'deg'], kind: 'number' }
}

function withAlpha(
  space: CssColorSpace,
  coords: Vec3,
  alpha: Component | null
): ParsedCssColor | null {
  if (!alpha) {
    return null
  }
  const missing = alpha.kind === 'none'
  return parsedFromCoords(space, coords, missing ? 0 : clamp(alpha.value), missing)
}

function hex(value: string): ParsedCssColor | null {
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(value)) {
    return null
  }
  const body = value.slice(1)
  const digits = body.length <= 4 ? body.replace(/./g, (digit) => digit + digit) : body
  const at = (index: number): number => Number.parseInt(digits.slice(index, index + 2), 16) / 255
  return parsedFromCoords('srgb', [at(0), at(2), at(4)], digits.length === 8 ? at(6) : 1)
}

/** The three channels and the alpha of a color function, modern or (rgb/hsl) legacy syntax. */
function channels(
  name: string,
  body: string
): { parts: string[]; alpha: Component | null; legacy: boolean } | null {
  const commas = splitTopLevel(body, ',')
  if (commas.length > 1) {
    // Why strict: Chromium refuses legacy syntax with `none`, empty parts, or outside rgb/hsl.
    const valid =
      LEGACY_FUNCTIONS.has(name) &&
      (commas.length === 3 || commas.length === 4) &&
      commas.every((part) => part !== 'none' && words(part).length === 1)
    return valid
      ? {
          parts: commas.slice(0, 3),
          alpha: commas[3] ? component(commas[3], 1) : ONE,
          legacy: true
        }
      : null
  }
  const slash = splitTopLevel(body, '/')
  if (slash.length > 2 || (slash.length === 2 && words(slash[1]).length !== 1)) {
    return null
  }
  const parts = words(slash[0])
  return parts.length === 3
    ? { parts, alpha: slash[1] === undefined ? ONE : component(slash[1], 1), legacy: false }
    : null
}

function rgbFunction(
  parts: string[],
  alpha: Component | null,
  legacy: boolean
): ParsedCssColor | null {
  const [r, g, b] = parts.map((part) => component(part, 255))
  if (!r || !g || !b || (legacy && !(r.kind === g.kind && g.kind === b.kind))) {
    return null
  }
  // Why clamp here: Chromium clamps rgb() channels when it parses them, before any color-mix.
  const channel = (c: Component): number =>
    Number.isNaN(c.value) ? c.value : Math.min(1, Math.max(0, c.value / 255))
  return withAlpha('srgb', [channel(r), channel(g), channel(b)], alpha)
}

function hueFunction(
  space: 'hsl' | 'hwb',
  parts: string[],
  alpha: Component | null,
  legacy: boolean
): ParsedCssColor | null {
  const h = angle(parts[0])
  const first = component(parts[1], 100)
  const second = component(parts[2], 100)
  if (
    !h ||
    !first ||
    !second ||
    (legacy && (first.kind !== 'percent' || second.kind !== 'percent'))
  ) {
    return null
  }
  const coords: Vec3 =
    space === 'hsl'
      ? [h.value, clamp(first.value, 0, 100), clamp(second.value, 0, 100)]
      : [h.value, first.value, second.value]
  return withAlpha(space, coords, alpha)
}

function labFunction(
  space: 'lab' | 'lch' | 'oklab' | 'oklch',
  parts: string[],
  alpha: Component | null
): ParsedCssColor | null {
  const ok = space === 'oklab' || space === 'oklch'
  const polar = space === 'lch' || space === 'oklch'
  const l = component(parts[0], ok ? 1 : 100)
  const second = component(parts[1], space === 'lch' ? 150 : space === 'lab' ? 125 : 0.4)
  const third = polar ? angle(parts[2]) : component(parts[2], space === 'lab' ? 125 : 0.4)
  if (!l || !second || !third) {
    return null
  }
  const lightness = Number.isNaN(l.value) ? l.value : clamp(l.value, 0, ok ? 1 : 100)
  const chroma = polar && !Number.isNaN(second.value) ? Math.max(0, second.value) : second.value
  return withAlpha(space, [lightness, chroma, third.value], alpha)
}

/** `color(<space> c1 c2 c3 [/ alpha])`. */
function colorSpaceFunction(body: string): ParsedCssColor | null {
  const slash = splitTopLevel(body, '/')
  const [space, ...rest] = words(slash[0] ?? '')
  if (slash.length > 2 || rest.length !== 3 || !space || !PREDEFINED_SPACES.has(space)) {
    return null
  }
  const target = spaceOf(space === 'xyz' ? 'xyz-d65' : space)
  const [a, b, c] = rest.map((part) => component(part, 1))
  if (!target || !a || !b || !c) {
    return null
  }
  const alpha = slash[1] === undefined ? ONE : component(slash[1], 1)
  return withAlpha(target, [a.value, b.value, c.value], alpha)
}

export function parseCssColor(input: string): ParseResult {
  const value = input.trim().toLowerCase()
  if (value === 'transparent') {
    return parsedFromCoords('srgb', [0, 0, 0], 0)
  }
  // Why black: the canvas probe paints currentColor as its default black, so the gate already
  // treats it that way; matching keeps the CLI's verdict the renderer's.
  if (value === 'currentcolor') {
    return parsedFromCoords('srgb', [0, 0, 0], 1)
  }
  if (SYSTEM_COLORS.has(value)) {
    return UNCHECKED
  }
  if (value.startsWith('#')) {
    return hex(value)
  }
  const named = CSS_NAMED_COLORS.get(value)
  if (named) {
    return hex(`#${named}`)
  }
  const match = /^([a-z-]+)\((.*)\)$/s.exec(value)
  if (!match) {
    return null
  }
  const name = match[1]
  const body = match[2].trim()
  // Why unchecked: relative colors and math resolve in the browser; this probe does not model them.
  if (/^from\s/.test(body) || /\b(?:calc|min|max|clamp|var|env|attr)\(/.test(body)) {
    return UNCHECKED
  }
  if (name === 'color-mix') {
    return colorMix(body, parseCssColor)
  }
  if (name === 'color') {
    return colorSpaceFunction(body)
  }
  const parsed = channels(name, body)
  if (!parsed) {
    return null
  }
  const { parts, alpha, legacy } = parsed
  switch (name) {
    case 'rgb':
    case 'rgba':
      return rgbFunction(parts, alpha, legacy)
    case 'hsl':
    case 'hsla':
      return hueFunction('hsl', parts, alpha, legacy)
    case 'hwb':
      return hueFunction('hwb', parts, alpha, legacy)
    case 'lab':
    case 'lch':
    case 'oklab':
    case 'oklch':
      return labFunction(name, parts, alpha)
    default:
      return null
  }
}

/**
 * Resolves a CSS color without a browser, as the renderer's canvas probe does: out-of-gamut
 * channels are clipped, and the result is stored as 8-bit premultiplied color, so translucent
 * values round the way the painted pixel does. `currentColor` is opaque black, as on the canvas.
 * Null for anything that is not a color (keywords like `inherit`, `var()`), and for valid CSS this
 * probe does not model (see css-color-unchecked.ts).
 */
export const cssColorProbe: ColorProbe = (value) => {
  const color = parseCssColor(value)
  if (color === null || color === UNCHECKED || color.rgb.some((c) => !Number.isFinite(c))) {
    return null
  }
  const alpha = Math.round(clamp(color.alpha) * 255)
  if (alpha === 0) {
    return [0, 0, 0, 0]
  }
  const channel = (c: number): number => {
    const premultiplied = Math.round((Math.round(clamp(c) * 255) * alpha) / 255)
    return Math.min(255, Math.round((premultiplied * 255) / alpha))
  }
  const rgba: Rgba = [
    channel(color.rgb[0]),
    channel(color.rgb[1]),
    channel(color.rgb[2]),
    alpha / 255
  ]
  return rgba
}
