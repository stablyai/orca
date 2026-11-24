/** Numbers each path command takes per segment (SVG 2 path grammar). */
const COMMAND_ARITY: Readonly<Record<string, number>> = {
  m: 2,
  l: 2,
  t: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  a: 7,
  z: 0
}
// Why only these: SVG path data allows no other whitespace, so a browser stops drawing at e.g. U+00A0.
const SVG_WHITESPACE = new Set([' ', '\t', '\r', '\n', '\f'])
// Arc segments are rx ry rotation large-arc-flag sweep-flag x y; the flags are a single 0 or 1.
const ARC_FLAG_ARGS = new Set([3, 4])

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function skipWhitespace(data: string, at: number): number {
  let index = at
  while (SVG_WHITESPACE.has(data[index] ?? '')) {
    index++
  }
  return index
}

/** Skips `comma-wsp?`: whitespace, at most one comma, whitespace. */
function skipSeparator(data: string, at: number): { index: number; comma: boolean } {
  let index = skipWhitespace(data, at)
  const comma = data[index] === ','
  if (comma) {
    index = skipWhitespace(data, index + 1)
  }
  return { index, comma }
}

function skipDigits(data: string, at: number): number {
  let index = at
  while (isDigit(data[index])) {
    index++
  }
  return index
}

/** End of the number starting at `at`, or -1. Reads `1`, `.5`, `1e-3`, and also `1.` so that
 *  numberIssue names the trailing dot rather than reporting a missing number. */
function readNumber(data: string, at: number): number {
  let index = at
  if (data[index] === '+' || data[index] === '-') {
    index++
  }
  const integerEnd = skipDigits(data, index)
  let end = integerEnd
  if (data[end] === '.') {
    end = skipDigits(data, end + 1)
  }
  // Why: a lone sign or dot has no digits, so it is not a number.
  if (integerEnd === index && end <= integerEnd + 1) {
    return -1
  }
  if (data[end] === 'e' || data[end] === 'E') {
    const sign = data[end + 1] === '+' || data[end + 1] === '-' ? 1 : 0
    const exponentEnd = skipDigits(data, end + 1 + sign)
    // Why: `1e` without digits is not an exponent; the `e` is then an unknown command.
    if (exponentEnd > end + 1 + sign) {
      end = exponentEnd
    }
  }
  return end
}

// Why float limits: Chromium reads path numbers as 32-bit floats and stops drawing at a
// positive exponent above 38, or at a value past the float range, so `1e39` and even
// `0.001e39` cut the path short. A negative exponent of any size just reads as 0.
const FLOAT_MAX_EXPONENT = 38
// Why 38 digits: a spelling whose written integer part is near FLT_MAX is cut short by Chromium
// even when its scaled value is small. `340282350000000000000000000000000000000e-38` (about 3.4)
// was drawn only up to the first segment, with no warning, so any integer part past 38 digits is
// refused whatever its scaled value. Anything below 1e38 is far inside the float range.
const MAX_INTEGER_DIGITS = 38
const FLOAT_MAX = 3.4028234663852886e38
const POSITIVE_EXPONENT = /[eE]\+?(\d+)$/
const INTEGER_PART = /^[+-]?(\d*)/

/** Why Chromium would not draw the number `literal`, or null. */
function numberIssue(literal: string, at: number): string | null {
  // Why: Chromium needs a digit after the dot, so `1.` or `1.e2` stops the path there.
  if (/\.(?!\d)/.test(literal)) {
    return `has a number at position ${at + 1} that ends with a dot; write a digit after it or drop the dot`
  }
  const exponent = POSITIVE_EXPONENT.exec(literal)?.[1]
  // Why strip zeros: leading zeros are not digits of the magnitude.
  const integerDigits = (INTEGER_PART.exec(literal)?.[1] ?? '').replace(/^0+/, '')
  // Why `>=` and not a rounded check: a value just above FLT_MAX rounds back to FLT_MAX, so
  // Math.fround would accept what Chromium cuts short.
  if (
    (exponent !== undefined && Number(exponent) > FLOAT_MAX_EXPONENT) ||
    integerDigits.length > MAX_INTEGER_DIGITS ||
    Math.abs(Number(literal)) >= FLOAT_MAX
  ) {
    return `has a number at position ${at + 1} that is too large to draw`
  }
  return null
}

function startsNumber(char: string | undefined): boolean {
  return isDigit(char) || char === '.' || char === '+' || char === '-'
}

/** Why the data is not drawable SVG path data, or null when it is. Checks each command's
 *  arity, arc flags, separators and numbers (no trailing dot, within float range), so a
 *  browser draws every segment rather than stopping at the first error. Compact forms such
 *  as `M0 0l1-1`, `.5.5` and `1e-3` are legal. */
export function svgPathDataIssue(data: string): string | null {
  if (data[0] !== 'M' && data[0] !== 'm') {
    return 'must start with M or m'
  }
  let index = 0
  while (index < data.length) {
    const command = data[index] ?? ''
    const arity = COMMAND_ARITY[command.toLowerCase()]
    if (arity === undefined) {
      return `has an unexpected character at position ${index + 1}; expected a path command`
    }
    const commandAt = index
    index = skipWhitespace(data, index + 1)
    if (arity === 0) {
      continue
    }
    for (;;) {
      for (let arg = 0; arg < arity; arg++) {
        if (arg > 0) {
          index = skipSeparator(data, index).index
        }
        if (command.toLowerCase() === 'a' && ARC_FLAG_ARGS.has(arg)) {
          if (data[index] !== '0' && data[index] !== '1') {
            return `has an arc flag at position ${index + 1} that is not 0 or 1`
          }
          index++
          continue
        }
        const end = readNumber(data, index)
        if (end < 0) {
          return `command "${command}" at position ${commandAt + 1} needs ${arity} numbers per segment`
        }
        const issue = numberIssue(data.slice(index, end), index)
        if (issue) {
          return issue
        }
        index = end
      }
      const next = skipSeparator(data, index)
      if (startsNumber(data[next.index])) {
        index = next.index
        continue
      }
      if (next.comma) {
        return `has a comma at position ${skipWhitespace(data, index) + 1} with no number after it`
      }
      index = next.index
      break
    }
  }
  return null
}
