import { CSS_COLOR_SPACES, type CssColorSpace, type Vec3 } from './css-color-spaces'

// What the color parser and color-mix() share; split out so neither imports the other.

/** A parsed color: unclipped sRGB 0-1, plus its own space's coordinates (NaN where `none`). */
export type ParsedCssColor = {
  rgb: Vec3
  alpha: number
  space: CssColorSpace
  coords: Vec3
  alphaMissing: boolean
}

/** Valid CSS a browser paints but this probe does not model (relative colors, calc(), …). */
export const UNCHECKED = 'unchecked'
export type ParseResult = ParsedCssColor | null | typeof UNCHECKED

export const CSS_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/
/** Splits on top-level separators, leaving nested functions whole; keeps empty parts. */
export function splitTopLevel(text: string, separator: ',' | '/'): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0
    if (depth === 0 && char === separator) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current.trim())
  return parts
}

export const words = (text: string): string[] => text.split(/\s+/).filter((part) => part.length > 0)

const fill = (coords: Vec3): Vec3 => [
  Number.isNaN(coords[0]) ? 0 : coords[0],
  Number.isNaN(coords[1]) ? 0 : coords[1],
  Number.isNaN(coords[2]) ? 0 : coords[2]
]

export function parsedFromCoords(
  space: CssColorSpace,
  coords: Vec3,
  alpha: number,
  alphaMissing = false
): ParsedCssColor {
  return { rgb: CSS_COLOR_SPACES[space].from(fill(coords)), alpha, space, coords, alphaMissing }
}

function isCssColorSpace(name: string): name is CssColorSpace {
  return Object.hasOwn(CSS_COLOR_SPACES, name)
}

export const spaceOf = (name: string): CssColorSpace | null => (isCssColorSpace(name) ? name : null)
