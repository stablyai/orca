import type { Rgba } from '../color/rgba-contrast'
import {
  displayP3ToSrgb,
  fromLinear,
  hslToSrgb,
  labToSrgb,
  oklabToSrgb,
  srgbToOklab,
  toLinear
} from './css-color-spaces'
import { CSS_NAMED_COLORS } from './css-named-colors'
import type { ColorProbe } from './theme-contrast-engine'

/** sRGB channels 0-1 before quantizing; alpha 0-1. */
type Color = [number, number, number, number]

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/
const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value))

/** A number, a percentage of `percentOf`, or `none` (0); null when neither. */
function amount(raw: string, percentOf: number): number | null {
  if (raw === 'none') {
    return 0
  }
  const percent = raw.endsWith('%')
  const text = percent ? raw.slice(0, -1) : raw
  if (!NUMBER.test(text)) {
    return null
  }
  return percent ? (Number(text) / 100) * percentOf : Number(text)
}

function angle(raw: string): number | null {
  if (raw === 'none') {
    return 0
  }
  const match = /^(.*?)(deg|turn|rad|grad)?$/.exec(raw)
  if (!match || !NUMBER.test(match[1])) {
    return null
  }
  const value = Number(match[1])
  const unit = match[2]
  return unit === 'turn'
    ? value * 360
    : unit === 'rad'
      ? (value * 180) / Math.PI
      : unit === 'grad'
        ? value * 0.9
        : value
}

/** Splits on top-level separators, leaving nested functions whole. */
function splitTopLevel(text: string, separator: ',' | ' ' | '/'): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
    }
    const splits = depth === 0 && (separator === ' ' ? /\s/.test(char) : char === separator)
    if (splits) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current.trim())
  return parts.filter((part) => part.length > 0)
}

function hex(value: string): Color | null {
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(value)) {
    return null
  }
  const digits =
    value.length <= 5
      ? value
          .slice(1)
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : value.slice(1)
  const at = (index: number): number => Number.parseInt(digits.slice(index, index + 2), 16) / 255
  return [at(0), at(2), at(4), digits.length === 8 ? at(6) : 1]
}

/** The channels and alpha of a color function's body, legacy commas or modern spaces. */
function channels(body: string, legacyAllowed: boolean): { parts: string[]; alpha: number } | null {
  const commas = splitTopLevel(body, ',')
  let parts: string[]
  let alphaRaw: string | undefined
  if (commas.length > 1) {
    if (!legacyAllowed || (commas.length !== 3 && commas.length !== 4)) {
      return null
    }
    parts = commas.slice(0, 3)
    alphaRaw = commas[3]
  } else {
    const slash = splitTopLevel(body, '/')
    if (slash.length === 0 || slash.length > 2) {
      return null
    }
    parts = splitTopLevel(slash[0], ' ')
    alphaRaw = slash[1]
    if (parts.length !== 3) {
      return null
    }
  }
  const alpha = alphaRaw === undefined ? 1 : amount(alphaRaw, 1)
  return alpha === null ? null : { parts, alpha: clamp(alpha) }
}

function colorFunction(name: string, body: string): Color | null {
  if (name === 'color-mix') {
    return colorMix(body)
  }
  if (name === 'color') {
    const [space, ...rest] = splitTopLevel(body, ' ')
    const parsed = channels(rest.join(' '), false)
    const values = parsed?.parts.map((part) => amount(part, 1))
    if (!parsed || !values || values.some((value) => value === null)) {
      return null
    }
    const [r, g, b] = values as number[]
    const rgb =
      space === 'srgb'
        ? [r, g, b]
        : space === 'srgb-linear'
          ? [fromLinear(r), fromLinear(g), fromLinear(b)]
          : space === 'display-p3'
            ? displayP3ToSrgb(r, g, b)
            : null
    return rgb ? [rgb[0], rgb[1], rgb[2], parsed.alpha] : null
  }
  const legacy = ['rgb', 'rgba', 'hsl', 'hsla'].includes(name)
  const parsed = channels(body, legacy)
  if (!parsed) {
    return null
  }
  const [p0, p1, p2] = parsed.parts
  let rgb: [number, number, number] | null = null
  switch (name) {
    case 'rgb':
    case 'rgba': {
      const values = [p0, p1, p2].map((part) => amount(part, 255))
      rgb = values.every((value) => value !== null)
        ? (values.map((value) => (value as number) / 255) as [number, number, number])
        : null
      break
    }
    case 'hsl':
    case 'hsla':
    case 'hwb': {
      const h = angle(p0)
      const first = amount(p1, 100)
      const second = amount(p2, 100)
      if (h === null || first === null || second === null) {
        return null
      }
      const hue = ((h % 360) + 360) % 360
      if (name === 'hwb') {
        const [w, b] = [clamp(first / 100), clamp(second / 100)]
        rgb =
          w + b >= 1
            ? [w / (w + b), w / (w + b), w / (w + b)]
            : (hslToSrgb(hue, 1, 0.5).map((c) => c * (1 - w - b) + w) as [number, number, number])
      } else {
        rgb = hslToSrgb(hue, clamp(first / 100), clamp(second / 100))
      }
      break
    }
    case 'lab':
    case 'oklab':
    case 'lch':
    case 'oklch': {
      const ok = name.startsWith('ok')
      const l = amount(p0, ok ? 1 : 100)
      const second = amount(p1, name === 'lch' ? 150 : name === 'lab' ? 125 : 0.4)
      if (l === null || second === null) {
        return null
      }
      const lightness = clamp(l, 0, ok ? 1 : 100)
      let a = second
      let b: number | null
      if (name.endsWith('lch')) {
        const h = angle(p2)
        if (h === null) {
          return null
        }
        const chroma = Math.max(0, second)
        a = chroma * Math.cos((h * Math.PI) / 180)
        b = chroma * Math.sin((h * Math.PI) / 180)
      } else {
        b = amount(p2, name === 'lab' ? 125 : 0.4)
      }
      if (b === null) {
        return null
      }
      rgb = ok ? oklabToSrgb(lightness, a, b) : labToSrgb(lightness, a, b)
      break
    }
    default:
      return null
  }
  return rgb ? [rgb[0], rgb[1], rgb[2], parsed.alpha] : null
}

/** `color-mix(in <space>, a [p%], b [q%])` with premultiplied alpha, per CSS Color 5. */
function colorMix(body: string): Color | null {
  const [method, first, second, ...extra] = splitTopLevel(body, ',')
  const space = /^in\s+([a-z-]+)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?$/.exec(
    method ?? ''
  )
  if (!space || !first || !second || extra.length > 0) {
    return null
  }
  const side = (text: string): { color: Color; percent: number | null } | null => {
    const parts = splitTopLevel(text, ' ')
    const percentPart = parts.find((part) => part.endsWith('%') && NUMBER.test(part.slice(0, -1)))
    const colorText = parts.filter((part) => part !== percentPart).join(' ')
    const color = parse(colorText)
    return color ? { color, percent: percentPart ? Number(percentPart.slice(0, -1)) : null } : null
  }
  const a = side(first)
  const b = side(second)
  if (!a || !b) {
    return null
  }
  let p1 = a.percent
  let p2 = b.percent
  if (p1 === null && p2 === null) {
    p1 = 50
    p2 = 50
  } else if (p1 === null) {
    p1 = 100 - (p2 as number)
  } else if (p2 === null) {
    p2 = 100 - p1
  }
  const total = (p1 as number) + (p2 as number)
  if (p1! < 0 || p2! < 0 || p1! > 100 || p2! > 100 || total === 0) {
    return null
  }
  const w1 = p1! / total
  const w2 = p2! / total
  const alphaScale = total < 100 ? total / 100 : 1
  const into = (color: Color): [number, number, number] => {
    switch (space[1]) {
      case 'srgb':
        return [color[0], color[1], color[2]]
      case 'srgb-linear':
        return [toLinear(color[0]), toLinear(color[1]), toLinear(color[2])]
      case 'oklab':
        return srgbToOklab(color)
      default:
        return [Number.NaN, Number.NaN, Number.NaN]
    }
  }
  const from = ([x, y, z]: number[]): [number, number, number] =>
    space[1] === 'srgb'
      ? [x, y, z]
      : space[1] === 'srgb-linear'
        ? [fromLinear(x), fromLinear(y), fromLinear(z)]
        : oklabToSrgb(x, y, z)
  const c1 = into(a.color)
  const c2 = into(b.color)
  if (c1.some(Number.isNaN)) {
    return null
  }
  const alpha = a.color[3] * w1 + b.color[3] * w2
  const mixed =
    alpha === 0
      ? [0, 0, 0]
      : [0, 1, 2].map((i) => (c1[i] * a.color[3] * w1 + c2[i] * b.color[3] * w2) / alpha)
  const rgb = from(mixed)
  return [rgb[0], rgb[1], rgb[2], alpha * alphaScale]
}

function parse(input: string): Color | null {
  const value = input.trim().toLowerCase()
  if (value === 'transparent') {
    return [0, 0, 0, 0]
  }
  // Why black: the canvas probe paints currentColor as its default black, so the gate already
  // treats it that way; matching keeps the CLI's verdict the renderer's.
  if (value === 'currentcolor') {
    return [0, 0, 0, 1]
  }
  if (value.startsWith('#')) {
    return hex(value)
  }
  const named = CSS_NAMED_COLORS.get(value)
  if (named) {
    return hex(`#${named}`)
  }
  const match = /^([a-z-]+)\((.*)\)$/s.exec(value)
  return match ? colorFunction(match[1], match[2].trim()) : null
}

/**
 * Resolves a CSS color without a browser, as the renderer's canvas probe does: out-of-gamut
 * channels are clipped, and the result is stored as 8-bit premultiplied color, so translucent
 * values round the way the painted pixel does. Null for anything that is not a color the theme
 * gate accepts (keywords like `inherit`, `currentColor`, `var()`).
 */
export const cssColorProbe: ColorProbe = (value) => {
  const color = parse(value)
  if (!color || color.some((channel) => !Number.isFinite(channel))) {
    return null
  }
  const alpha = Math.round(clamp(color[3]) * 255)
  if (alpha === 0) {
    return [0, 0, 0, 0]
  }
  const channel = (c: number): number => {
    const premultiplied = Math.round((Math.round(clamp(c) * 255) * alpha) / 255)
    return Math.min(255, Math.round((premultiplied * 255) / alpha))
  }
  const rgba: Rgba = [channel(color[0]), channel(color[1]), channel(color[2]), alpha / 255]
  return rgba
}
