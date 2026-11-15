import { parseCssColor, UNCHECKED } from './css-color-probe'

/** True for valid CSS the browser would resolve but this probe cannot (system colors, relative
 *  colors, calc()), so a check can say "not checked" instead of calling it invalid. */
export function cssColorProbeUnchecked(value: string): boolean {
  return parseCssColor(value) === UNCHECKED
}

/** A theme's tokens split into those the probe can check and the valid CSS it cannot. */
export function splitUncheckedColors(tokens: Readonly<Record<string, string>>): {
  checked: Record<string, string>
  unchecked: string[]
} {
  const checked: Record<string, string> = {}
  const unchecked: string[] = []
  for (const [token, value] of Object.entries(tokens)) {
    if (cssColorProbeUnchecked(value)) {
      unchecked.push(token)
    } else {
      checked[token] = value
    }
  }
  return { checked, unchecked }
}
