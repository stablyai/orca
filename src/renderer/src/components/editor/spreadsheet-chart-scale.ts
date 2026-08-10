export type SpreadsheetChartScale = {
  min: number
  max: number
  /** Tick values in ascending order, at round numbers. */
  ticks: number[]
}

// Why: axis ticks land on numbers a reader recognizes — 0 / 1,000 / 2,000, never
// 0 / 917 / 1,834. These are the steps a decade is allowed to be divided into.
const TICK_STEP_MULTIPLES = [1, 2, 2.5, 5, 10] as const
const TARGET_TICK_COUNT = 5

/**
 * Builds a value axis over the plotted numbers.
 *
 * `includeZero` is true for the forms that grow from a baseline — a column or
 * area chart that starts at 900 exaggerates every difference, which is the
 * classic way a chart lies. Lines and scatters may frame their own range.
 */
export function buildSpreadsheetChartScale(
  values: readonly (number | null)[],
  { includeZero }: { includeZero: boolean }
): SpreadsheetChartScale {
  const numbers = values.filter(
    (value): value is number => value !== null && Number.isFinite(value)
  )
  if (numbers.length === 0) {
    return { min: 0, max: 1, ticks: [0, 1] }
  }

  let min = Math.min(...numbers)
  let max = Math.max(...numbers)
  if (includeZero) {
    min = Math.min(min, 0)
    max = Math.max(max, 0)
  }
  if (min === max) {
    // Why: a flat series still needs a band to draw in.
    const padding = Math.abs(min) || 1
    min -= padding
    max += padding
  }

  const step = chooseTickStep(max - min)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let tick = niceMin; tick <= niceMax + step / 2; tick += step) {
    // Why: accumulating a float step drifts, so each tick is snapped back onto it.
    ticks.push(Number((Math.round(tick / step) * step).toPrecision(12)))
  }

  return { min: niceMin, max: niceMax, ticks }
}

function chooseTickStep(range: number): number {
  const rawStep = range / TARGET_TICK_COUNT
  const decade = 10 ** Math.floor(Math.log10(rawStep))
  for (const multiple of TICK_STEP_MULTIPLES) {
    if (decade * multiple >= rawStep) {
      return decade * multiple
    }
  }
  return decade * 10
}

/** Fraction of the axis a value sits at, from 0 at the minimum to 1 at the maximum. */
export function projectOntoScale(value: number, scale: SpreadsheetChartScale): number {
  const span = scale.max - scale.min
  return span === 0 ? 0 : (value - scale.min) / span
}
