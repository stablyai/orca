import { CSS_COLOR_SPACES, type CssColorSpace, type Vec3 } from './css-color-spaces'
import {
  CSS_NUMBER,
  parsedFromCoords,
  spaceOf,
  splitTopLevel,
  UNCHECKED,
  words,
  type ParsedCssColor,
  type ParseResult
} from './css-color-probe'

const HUE_METHODS = ['shorter', 'longer', 'increasing', 'decreasing'] as const
type HueMethod = (typeof HUE_METHODS)[number]
const hueMethodOf = (text: string | undefined): HueMethod =>
  HUE_METHODS.find((method) => method === text) ?? 'shorter'

/** Hue pair adjusted for the interpolation method, per CSS Color 4 §12.4. */
function hueFor(h1: number, h2: number, method: HueMethod): [number, number] {
  const diff = h2 - h1
  switch (method) {
    case 'shorter':
      return diff > 180 ? [h1 + 360, h2] : diff < -180 ? [h1, h2 + 360] : [h1, h2]
    case 'longer':
      return diff > 0 && diff < 180
        ? [h1 + 360, h2]
        : diff > -180 && diff <= 0
          ? [h1, h2 + 360]
          : [h1, h2]
    case 'increasing':
      return diff < 0 ? [h1, h2 + 360] : [h1, h2]
    case 'decreasing':
      return diff > 0 ? [h1 + 360, h2] : [h1, h2]
  }
}

/** Coordinates of `color` in `space`, keeping its own missing components when written there. */
function coordsIn(color: ParsedCssColor, space: CssColorSpace): Vec3 | null {
  if (color.space === space) {
    return color.coords
  }
  const to = CSS_COLOR_SPACES[space].to
  return to ? to(color.rgb) : null
}

// Why: a missing component (`none`, or a powerless hue) takes the other color's value.
const pick = (x: number, y: number): [number, number] => [
  Number.isNaN(x) ? y : x,
  Number.isNaN(y) ? x : y
]

type Side = { color: ParsedCssColor; percent: number | null }

function side(text: string, parse: (value: string) => ParseResult): Side | null | typeof UNCHECKED {
  const parts = words(text)
  const percents = parts.filter((part) => part.endsWith('%') && CSS_NUMBER.test(part.slice(0, -1)))
  if (percents.length > 1) {
    return null
  }
  const color = parse(parts.filter((part) => part !== percents[0]).join(' '))
  if (color === UNCHECKED || color === null) {
    return color
  }
  return { color, percent: percents[0] === undefined ? null : Number(percents[0].slice(0, -1)) }
}

/** Normalized weights and the alpha multiplier, or null when the percentages are invalid. */
function weights(a: number | null, b: number | null): [number, number, number] | null {
  const p1 = a ?? (b === null ? 50 : 100 - b)
  const p2 = b ?? (a === null ? 50 : 100 - a)
  const total = p1 + p2
  if (p1 < 0 || p2 < 0 || p1 > 100 || p2 > 100 || total === 0) {
    return null
  }
  return [p1 / total, p2 / total, total < 100 ? total / 100 : 1]
}

/** `color-mix(in <space> [<method> hue], a [p%], b [q%])`, premultiplied, per CSS Color 5. */
export function colorMix(body: string, parse: (value: string) => ParseResult): ParseResult {
  const [method, first, second, ...extra] = splitTopLevel(body, ',')
  const match = /^in\s+([a-z0-9-]+)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?$/.exec(
    method ?? ''
  )
  const space = match ? spaceOf(match[1] === 'xyz' ? 'xyz-d65' : match[1]) : null
  if (!match || !space || !first || !second || extra.length > 0) {
    return null
  }
  const spec = CSS_COLOR_SPACES[space]
  const hueIndex = 'hue' in spec ? spec.hue : null
  // Why: hue methods only exist for polar spaces; Chromium refuses them elsewhere.
  if (spec.to === null || (match[2] && hueIndex === null)) {
    return null
  }
  const a = side(first, parse)
  const b = side(second, parse)
  if (a === UNCHECKED || b === UNCHECKED) {
    return UNCHECKED
  }
  const weight = a && b ? weights(a.percent, b.percent) : null
  const c1 = a ? coordsIn(a.color, space) : null
  const c2 = b ? coordsIn(b.color, space) : null
  if (!a || !b || !weight || !c1 || !c2) {
    return null
  }
  const [w1, w2, alphaScale] = weight
  const [alpha1, alpha2] = pick(
    a.color.alphaMissing ? Number.NaN : a.color.alpha,
    b.color.alphaMissing ? Number.NaN : b.color.alpha
  ).map((value) => (Number.isNaN(value) ? 0 : value))
  const alpha = alpha1 * w1 + alpha2 * w2
  const component = (index: 0 | 1 | 2): number => {
    const [x, y] = pick(c1[index], c2[index])
    if (Number.isNaN(x)) {
      return Number.NaN
    }
    if (index === hueIndex) {
      const [h1, h2] = hueFor(
        ((x % 360) + 360) % 360,
        ((y % 360) + 360) % 360,
        hueMethodOf(match[2])
      )
      return h1 * w1 + h2 * w2
    }
    return alpha === 0 ? 0 : (x * alpha1 * w1 + y * alpha2 * w2) / alpha
  }
  return parsedFromCoords(space, [component(0), component(1), component(2)], alpha * alphaScale)
}
