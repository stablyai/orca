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

/** End of the number starting at `at`, or -1. Accepts `1`, `-1.`, `.5`, `1e-3`. */
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

function startsNumber(char: string | undefined): boolean {
  return isDigit(char) || char === '.' || char === '+' || char === '-'
}

/** Why the data is not drawable SVG path data, or null when it is. Checks each command's
 *  arity, arc flags and separators, so a browser draws every segment rather than stopping
 *  at the first error. Compact forms such as `M0 0l1-1`, `.5.5` and `1e-3` are legal. */
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
