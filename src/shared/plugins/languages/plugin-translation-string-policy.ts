/** Absolute cap for any one translation, including keys this Orca has no English text for. */
export const PLUGIN_TRANSLATION_MAX_CHARACTERS = 8192
// Why relative: a pack speaks with Orca's voice, so it must not turn "Retry" into a paragraph of instructions.
const SOURCE_LENGTH_FLOOR = 64
const SOURCE_LENGTH_MULTIPLIER = 4
const PLURAL_SUFFIX_RE = /_(?:zero|one|two|few|many|other)$/
// Trojan-source reordering marks (U+061C, U+200E-F, U+202A-E, U+2066-9).
const BIDI_CONTROL_RE = /\p{Bidi_Control}/u

/** English string length and line-break eligibility, encoded as length × 2 plus a newline bit. */
export type EnglishSourceLookup = (path: string) => number | undefined

export function englishSourceFacts(value: string): number {
  return value.length * 2 + Number(value.includes('\n'))
}

export type EnglishSourceEntry = [path: string, value: string]

export function englishSourceEntries(english: Record<string, unknown>): EnglishSourceEntry[] {
  const entries: EnglishSourceEntry[] = []
  const stack: [Record<string, unknown>, string][] = [[english, '']]
  while (stack.length > 0) {
    const [node, prefix] = stack.pop()!
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'string') {
        entries.push([path, value])
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        stack.push([Object.fromEntries(Object.entries(value)), path])
      }
    }
  }
  return entries
}

export function englishSourceLookup(english: Record<string, unknown>): EnglishSourceLookup {
  const entries = new Map(
    englishSourceEntries(english).map(([path, value]) => [path, englishSourceFacts(value)])
  )
  return withEnglishPluralFallback((path) => entries.get(path))
}

/** Use the English `_other` or base value when English has no exact plural form. */
export function withEnglishPluralFallback(readExact: EnglishSourceLookup): EnglishSourceLookup {
  return (path) => {
    const exact = readExact(path)
    if (exact !== undefined) {
      return exact
    }
    const base = path.replace(PLURAL_SUFFIX_RE, '')
    return base === path ? undefined : (readExact(`${base}_other`) ?? readExact(base))
  }
}

function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    // C0 except line feed, DEL and C1, line/paragraph separators, and a stray byte-order mark.
    if (
      (code <= 0x1f && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff
    ) {
      return true
    }
  }
  return BIDI_CONTROL_RE.test(value)
}

/** Why a pack may not use `value` at `path`, or null. Without `english`, only source-independent rules apply. */
export function pluginTranslationStringProblem(
  path: string,
  value: string,
  english?: EnglishSourceLookup
): string | null {
  if (hasForbiddenCharacter(value)) {
    return `translation at ${path} contains a control or bidirectional formatting character`
  }
  const source = english?.(path)
  if (english && value.includes('\n') && (source === undefined || source % 2 === 0)) {
    return `translation at ${path} adds a line break the English text does not have`
  }
  const limit =
    source === undefined
      ? PLUGIN_TRANSLATION_MAX_CHARACTERS
      : Math.min(
          PLUGIN_TRANSLATION_MAX_CHARACTERS,
          Math.max(SOURCE_LENGTH_FLOOR, SOURCE_LENGTH_MULTIPLIER * Math.floor(source / 2))
        )
  if (value.length > limit) {
    return source === undefined
      ? `translation at ${path} exceeds ${limit} characters`
      : `translation at ${path} exceeds ${limit} characters (${SOURCE_LENGTH_MULTIPLIER}x its English text, at least ${SOURCE_LENGTH_FLOOR})`
  }
  return null
}
