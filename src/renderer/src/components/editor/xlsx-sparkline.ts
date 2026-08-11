/**
 * Reads a Google Sheets `SPARKLINE()` out of a formula an .xlsx export left
 * behind, and resolves it against the sheet's own values.
 *
 * Why this exists: SPARKLINE draws a micro-chart inside a cell, and Excel has no
 * such function. Exporting to .xlsx wraps it in `__xludf.DUMMYFUNCTION("…")` — a
 * marker that preserves the formula text — and caches an empty result, so the cell
 * carries the author's intent but no value. Excel itself shows nothing there.
 * Drawing it is therefore *more* than Excel parity, deliberately: the chart the
 * author asked for is fully described in the file, and a reader wants to see it.
 */
export type XlsxSparklineChartType = 'line' | 'column' | 'bar' | 'winloss'

export type XlsxSparklineSpec = {
  chartType: XlsxSparklineChartType
  /** The A1 reference or range the sparkline plots. */
  dataReference: string
  /** Lowercased option names to their raw values, e.g. `ymax` to `MAX(D17:E17)`. */
  options: Record<string, string>
}

const DUMMY_FUNCTION_MARKER = '__xludf.DUMMYFUNCTION'
const SPARKLINE_CALL = 'SPARKLINE('
const CHART_TYPES: Record<string, XlsxSparklineChartType> = {
  line: 'line',
  column: 'column',
  bar: 'bar',
  winloss: 'winloss'
}

/** Parses the SPARKLINE call out of a cell formula, or null when there is none. */
export function parseXlsxSparklineFormula(formula: string): XlsxSparklineSpec | null {
  const callStart = formula.indexOf(SPARKLINE_CALL)
  if (callStart === -1) {
    return null
  }
  const body = readBalancedCall(formula, callStart + SPARKLINE_CALL.length)
  if (body === null) {
    return null
  }
  // Why: the call sits inside a string literal when it came through
  // DUMMYFUNCTION, so its own quotes were doubled to escape them.
  const normalized = formula.includes(DUMMY_FUNCTION_MARKER) ? body.replaceAll('""', '"') : body

  const [dataReference, optionsSource] = splitFirstArgument(normalized)
  if (dataReference === '') {
    return null
  }
  const options = parseOptions(optionsSource)
  return {
    chartType: CHART_TYPES[(options.charttype ?? 'line').toLowerCase()] ?? 'line',
    dataReference,
    options
  }
}

function readBalancedCall(formula: string, from: number): string | null {
  let depth = 1
  for (let index = from; index < formula.length; index += 1) {
    const char = formula[index]
    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return formula.slice(from, index)
      }
    }
  }
  return null
}

function splitFirstArgument(body: string): [string, string] {
  let depth = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '(' || char === '{') {
      depth += 1
    } else if (char === ')' || char === '}') {
      depth -= 1
    } else if (char === ',' && depth === 0) {
      return [stripQuotes(body.slice(0, index)), body.slice(index + 1)]
    }
  }
  return [stripQuotes(body), '']
}

// Why: the options are a Sheets array literal — `{"key",value; "key",value}` —
// with `;` between pairs and `,` between a name and its value.
function parseOptions(source: string): Record<string, string> {
  const braceStart = source.indexOf('{')
  const braceEnd = source.lastIndexOf('}')
  if (braceStart === -1 || braceEnd <= braceStart) {
    return {}
  }

  const options: Record<string, string> = {}
  for (const pair of splitTopLevel(source.slice(braceStart + 1, braceEnd), ';')) {
    const [name, value] = splitTopLevel(pair, ',')
    if (name === undefined || value === undefined) {
      continue
    }
    options[stripQuotes(name).toLowerCase()] = stripQuotes(value)
  }
  return options
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of source) {
    if (char === '(' || char === '{') {
      depth += 1
    } else if (char === ')' || char === '}') {
      depth -= 1
    }
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1).trim()
    : trimmed
}

/** A sparkline with its values and colours resolved, ready to draw. */
export type ResolvedXlsxSparkline = {
  chartType: XlsxSparklineChartType
  values: number[]
  min: number
  max: number
  color: string
  /** Colour for the first column, when the author set one. */
  firstColor?: string
  negativeColor?: string
}

const DEFAULT_SPARKLINE_COLOR = '#5b9bd5'
const NEGATIVE_SPARKLINE_COLOR = '#c0504d'

/**
 * Resolves a spec against the sheet, using `readRange` to look up the numbers a
 * reference covers. Returns null when the reference resolves to no numbers.
 */
export function resolveXlsxSparkline(
  spec: XlsxSparklineSpec,
  readRange: (reference: string) => number[]
): ResolvedXlsxSparkline | null {
  const values = readRange(spec.dataReference)
  if (values.length === 0) {
    return null
  }

  const dataMax = Math.max(...values, 0)
  const dataMin = Math.min(...values, 0)
  return {
    chartType: spec.chartType,
    values,
    min: readNumericOption(spec.options.ymin ?? spec.options.min, readRange) ?? dataMin,
    max: readNumericOption(spec.options.ymax ?? spec.options.max, readRange) ?? dataMax,
    color:
      spec.options.color ??
      spec.options.color1 ??
      spec.options.firstcolor ??
      DEFAULT_SPARKLINE_COLOR,
    firstColor: spec.options.firstcolor,
    negativeColor: spec.options.negcolor ?? spec.options.lowcolor ?? NEGATIVE_SPARKLINE_COLOR
  }
}

// Why: an option may be a literal or the one function Sheets writes here — a
// MAX/MIN over a range, used to pin the scale across sibling sparklines. Anything
// else falls back to the data's own bounds rather than guessing.
const RANGE_FUNCTION_PATTERN = /^(max|min)\s*\(\s*([^)]+?)\s*\)$/i

function readNumericOption(
  value: string | undefined,
  readRange: (reference: string) => number[]
): number | null {
  if (value === undefined) {
    return null
  }
  const literal = Number(value)
  if (Number.isFinite(literal) && value.trim() !== '') {
    return literal
  }
  const match = RANGE_FUNCTION_PATTERN.exec(value.trim())
  if (match === null) {
    return null
  }
  const numbers = readRange(match[2]!)
  if (numbers.length === 0) {
    return null
  }
  return match[1]!.toLowerCase() === 'max' ? Math.max(...numbers) : Math.min(...numbers)
}
