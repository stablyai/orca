// Why unquoted: CSS reads a quoted generic or vendor keyword as a plain family name.
const CSS_FONT_KEYWORDS = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'blinkmacsystemfont'
])

function isCssFontKeyword(fontFamily: string): boolean {
  return fontFamily.startsWith('-') || CSS_FONT_KEYWORDS.has(fontFamily.toLowerCase())
}

/** Quotes a family name, leaving a CSS generic or vendor keyword bare. */
function quoteFontFamilyOrKeyword(fontFamily: string): string {
  return isCssFontKeyword(fontFamily) ? fontFamily : JSON.stringify(fontFamily)
}

const isQuote = (char: string): boolean => char === '"' || char === "'"

// Why each end on its own, without a regex: `D2Coding", "Consolas` splits into `D2Coding"` and `"Consolas`.
function unquoteFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  let start = 0
  let end = trimmed.length
  while (start < end && isQuote(trimmed[start])) {
    start++
  }
  while (end > start && isQuote(trimmed[end - 1])) {
    end--
  }
  return trimmed.slice(start, end).trim()
}

/** The family names a setting such as `"Cascadia Mono", D2Coding` lists, unquoted. */
export function splitFontFamilyList(fontFamily: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < fontFamily.length; i++) {
    const char = fontFamily[i]
    if (!inQuote && (char === '"' || char === "'")) {
      // Only track quote state if the quote is at the start of a token or after whitespace/comma
      const prevChar = i > 0 ? fontFamily[i - 1] : ''
      if (prevChar === '' || prevChar === ',' || prevChar === ' ' || prevChar === '\t') {
        inQuote = true
        quoteChar = char
      }
      current += char
    } else if (inQuote && char === quoteChar) {
      inQuote = false
      quoteChar = ''
      current += char
    } else if (!inQuote && char === ',') {
      const trimmed = unquoteFontFamily(current)
      if (trimmed) {
        result.push(trimmed)
      }
      current = ''
    } else {
      current += char
    }
  }

  // Handle the last family
  const trimmed = unquoteFontFamily(current)
  if (trimmed) {
    result.push(trimmed)
  }

  return result
}

type FontFallback = { lower: string; quoted: string }

/** Lowercases each fallback for matching and quotes it unless it is a keyword. */
export function prepareFontFallbacks(fallbacks: readonly string[]): FontFallback[] {
  return fallbacks.map((fallback) => ({
    lower: fallback.toLowerCase(),
    quoted: quoteFontFamilyOrKeyword(fallback)
  }))
}

/** Each family quoted unless it is a keyword, then each fallback the families do not name. */
export function buildFontFamilyList(
  families: readonly string[],
  fallbacks: readonly FontFallback[]
): string {
  const listed = new Set(families.map((family) => family.toLowerCase()))
  return [
    ...families.map(quoteFontFamilyOrKeyword),
    ...fallbacks.filter(({ lower }) => !listed.has(lower)).map(({ quoted }) => quoted)
  ].join(', ')
}

/** Turns a setting such as `"Cascadia Mono", D2Coding` into a CSS font-family value. */
export function fontFamilyListBuilder(
  fallbacks: readonly string[]
): (fontFamily: string | null | undefined) => string {
  const prepared = prepareFontFallbacks(fallbacks)
  return (fontFamily) => buildFontFamilyList(splitFontFamilyList(fontFamily ?? ''), prepared)
}
