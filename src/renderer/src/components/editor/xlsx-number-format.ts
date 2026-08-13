/**
 * Turns a SpreadsheetML number format code into the parts needed to render a
 * value, then formats through `Intl.NumberFormat`.
 *
 * Why Intl rather than assembling digits by hand: the group and decimal
 * separators a format code implies are the viewer's, not the file's — the same
 * `#,##0.00` reads `1,000.00` in English and `1.000,00` in Spanish. Deriving
 * digit counts and grouping from the code and handing them to Intl gets every
 * locale right and leaves far less arithmetic to get wrong.
 */
export type XlsxNumericSection = {
  prefix: string
  suffix: string
  minFractionDigits: number
  maxFractionDigits: number
  minIntegerDigits: number
  useGrouping: boolean
  /** Percent codes scale by 100; each trailing comma scales down by 1000. */
  scale: number
  /** Colour named in the section, e.g. `[Red]` on a negative. */
  color?: string
}

export type XlsxNumericFormat = {
  positive: XlsxNumericSection
  negative?: XlsxNumericSection
  zero?: XlsxNumericSection
}

export type XlsxFormattedNumber = { text: string; color?: string }

const GENERAL_FORMAT_CODES = new Set(['', 'general', '@'])
// Why: the colour names a format code may carry. Excel also allows [Color 1..56]
// from the legacy palette; those are rare in modern files and are ignored rather
// than mapped to a guess.
const SECTION_COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#008000',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00'
}

export function isGeneralXlsxFormatCode(formatCode: string): boolean {
  return GENERAL_FORMAT_CODES.has(formatCode.trim().toLowerCase())
}

export function parseXlsxNumberFormatCode(formatCode: string): XlsxNumericFormat | null {
  if (isGeneralXlsxFormatCode(formatCode)) {
    return null
  }
  const sections = splitFormatSections(formatCode)
  const positive = parseSection(sections[0] ?? '')
  if (positive === null) {
    return null
  }
  return {
    positive,
    negative: sections[1] === undefined ? undefined : (parseSection(sections[1]) ?? undefined),
    zero: sections[2] === undefined ? undefined : (parseSection(sections[2]) ?? undefined)
  }
}

/** Splits on `;` while ignoring separators inside quotes, brackets or escapes. */
export function splitFormatSections(formatCode: string): string[] {
  const sections: string[] = []
  let current = ''
  let inQuotes = false
  let bracketDepth = 0

  for (let index = 0; index < formatCode.length; index += 1) {
    const char = formatCode[index]!
    if (char === '\\') {
      current += char + (formatCode[index + 1] ?? '')
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      current += char
      continue
    }
    if (!inQuotes && char === '[') {
      bracketDepth += 1
    } else if (!inQuotes && char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    }
    if (char === ';' && !inQuotes && bracketDepth === 0) {
      sections.push(current)
      current = ''
      continue
    }
    current += char
  }

  sections.push(current)
  return sections
}

function parseSection(section: string): XlsxNumericSection | null {
  let prefix = ''
  let suffix = ''
  let numeric = ''
  let color: string | undefined
  let percentCount = 0
  let seenNumeric = false

  for (let index = 0; index < section.length; index += 1) {
    const char = section[index]!
    if (char === '\\') {
      const literal = section[index + 1] ?? ''
      index += 1
      if (seenNumeric) {
        suffix += literal
      } else {
        prefix += literal
      }
      continue
    }
    if (char === '"') {
      const end = section.indexOf('"', index + 1)
      const literal = section.slice(index + 1, end === -1 ? undefined : end)
      index = end === -1 ? section.length : end
      if (seenNumeric) {
        suffix += literal
      } else {
        prefix += literal
      }
      continue
    }
    if (char === '[') {
      const end = section.indexOf(']', index + 1)
      const body = section.slice(index + 1, end === -1 ? undefined : end)
      index = end === -1 ? section.length : end
      // Why: a bracket section is a colour, a currency-and-locale hint, or a
      // condition. A colour changes how the value is drawn; a `[$€-2]` carries
      // the currency symbol itself and has to be rendered.
      const namedColor = SECTION_COLORS[body.trim().toLowerCase()]
      if (namedColor !== undefined) {
        color = namedColor
        continue
      }
      const currencySymbol = readCurrencySymbol(body)
      if (currencySymbol !== null) {
        if (seenNumeric) {
          suffix += currencySymbol
        } else {
          prefix += currencySymbol
        }
      }
      continue
    }
    if (char === '%') {
      percentCount += 1
      if (seenNumeric) {
        suffix += '%'
      } else {
        prefix += '%'
      }
      continue
    }
    if (char === '_') {
      // A skipped width: Excel reserves the width of the next character.
      index += 1
      if (seenNumeric) {
        suffix += ' '
      } else {
        prefix += ' '
      }
      continue
    }
    if (char === '*') {
      // A repeat-to-fill character, which a read-only cell has no room for.
      index += 1
      continue
    }
    if ('#0?.,'.includes(char)) {
      seenNumeric = true
      numeric += char
      continue
    }
    if (seenNumeric) {
      suffix += char
    } else {
      prefix += char
    }
  }

  if (!seenNumeric) {
    return null
  }
  const pattern = describeNumericPattern(numeric)
  // Why: both scalings compose — `0.0,,%` is a percentage of millions.
  return { ...pattern, prefix, suffix, color, scale: pattern.scale * 100 ** percentCount }
}

// Why: the bracket reads `[$<symbol>-<locale>]`, so the symbol is whatever sits
// between the leading `$` and the locale suffix. `[$-409]` carries no symbol at
// all and is only a locale hint.
function readCurrencySymbol(bracketBody: string): string | null {
  if (!bracketBody.startsWith('$')) {
    return null
  }
  const withoutMarker = bracketBody.slice(1)
  const localeSeparator = withoutMarker.lastIndexOf('-')
  const symbol = localeSeparator === -1 ? withoutMarker : withoutMarker.slice(0, localeSeparator)
  return symbol === '' ? null : symbol
}

type NumericPatternDescription = {
  minFractionDigits: number
  maxFractionDigits: number
  minIntegerDigits: number
  useGrouping: boolean
  scale: number
}

function describeNumericPattern(pattern: string): NumericPatternDescription {
  const decimalIndex = pattern.indexOf('.')
  const integerPart = decimalIndex === -1 ? pattern : pattern.slice(0, decimalIndex)
  const fractionPart = decimalIndex === -1 ? '' : pattern.slice(decimalIndex + 1)

  // Why: a comma between digit placeholders turns on grouping, but trailing
  // commas after the last placeholder scale the value down by a thousand each.
  const useGrouping = /,(?=[#0?])/.test(integerPart)
  const trailingCommas =
    /,+$/.exec(fractionPart === '' ? integerPart : fractionPart)?.[0].length ?? 0

  return {
    minIntegerDigits: countCharacters(integerPart, '0'),
    minFractionDigits: countCharacters(fractionPart, '0'),
    maxFractionDigits:
      countCharacters(fractionPart, '0') +
      countCharacters(fractionPart, '#') +
      countCharacters(fractionPart, '?'),
    useGrouping,
    scale: 1 / 1000 ** trailingCommas
  }
}

function countCharacters(value: string, character: string): number {
  let count = 0
  for (const char of value) {
    if (char === character) {
      count += 1
    }
  }
  return count
}

/** Formats a stored number through the section that matches its sign. */
export function formatXlsxNumericValue(
  value: number,
  format: XlsxNumericFormat,
  locale: string
): XlsxFormattedNumber {
  const section = pickSection(value, format)
  // Why: when the code declares its own negative section, that section owns the
  // sign — it usually writes it as a literal or wraps the value in parentheses,
  // so the number itself is formatted from its magnitude.
  const signed = value < 0 && format.negative !== undefined ? Math.abs(value) : value
  const scaled = signed * section.scale
  const text = new Intl.NumberFormat(locale, {
    minimumFractionDigits: Math.min(section.minFractionDigits, 20),
    maximumFractionDigits: Math.min(
      Math.max(section.maxFractionDigits, section.minFractionDigits),
      20
    ),
    minimumIntegerDigits: Math.min(Math.max(section.minIntegerDigits, 1), 21),
    useGrouping: section.useGrouping
  }).format(scaled)

  return { text: `${section.prefix}${text}${section.suffix}`, color: section.color }
}

function pickSection(value: number, format: XlsxNumericFormat): XlsxNumericSection {
  if (value < 0 && format.negative !== undefined) {
    return format.negative
  }
  if (value === 0 && format.zero !== undefined) {
    return format.zero
  }
  return format.positive
}
