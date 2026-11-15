import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/css-color-probe-chromium.json'
import { cssColorProbe } from './css-color-probe'
import { cssColorProbeUnchecked } from './css-color-unchecked'
import { THEME_BUILT_IN_VALUES } from './theme-built-in-values.generated'

type Row = [string, [number, number, number, number] | null]

// Why a looser bound for these: Chromium maps far-out-of-gamut Lab slightly differently than a
// plain clip; no theme value or built-in is this far out.
const OUT_OF_GAMUT = new Set(['lab(10 -100 100 / 0.3)', 'color(xyz-d65 0.2 0.3 0.4 / 50%)'])

describe('cssColorProbe parity with the renderer canvas probe', () => {
  const rows = fixture.rows as Row[]

  it('resolves every sample within one 8-bit step of Chromium', () => {
    const mismatches = rows.flatMap(([input, expected]) => {
      const got = cssColorProbe(input)
      // Why skip: system and relative colors are left to the app; the probe says unchecked.
      if (got === null && expected !== null && cssColorProbeUnchecked(input)) {
        return []
      }
      if (expected === null || got === null) {
        return (expected === null) === (got === null) ? [] : [{ input, got, expected }]
      }
      const tolerance = OUT_OF_GAMUT.has(input) ? 3 : 1
      const off =
        [0, 1, 2].some((channel) => Math.abs(got[channel] - expected[channel]) > tolerance) ||
        Math.abs(got[3] - expected[3]) * 255 > 1
      return off ? [{ input, got, expected }] : []
    })
    expect(mismatches).toEqual([])
  })

  it('covers every built-in token value', () => {
    const inputs = new Set(rows.map(([input]) => input))
    for (const mode of ['light', 'dark'] as const) {
      for (const value of Object.values(THEME_BUILT_IN_VALUES[mode])) {
        expect(value === '' || inputs.has(value), value).toBe(true)
      }
    }
  })
})
