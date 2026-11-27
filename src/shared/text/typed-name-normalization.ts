export function stripWrappingQuotes(value: string): string {
  const quote = value[0]
  return value.length >= 2 && (quote === "'" || quote === '"') && value.at(-1) === quote
    ? value.slice(1, -1)
    : value
}

/** How a typed host, server or project name is compared: trimmed, unquoted, case-insensitive, composed (NFC). */
export function normalizeTypedName(value: string): string {
  // Composed after lowercasing, which can leave a sequence decomposed (J + U+030C -> j + U+030C).
  return stripWrappingQuotes(value.trim()).trim().toLowerCase().normalize('NFC')
}

/** Case-sensitive match for a typed name; composed and decomposed (macOS NFD) spellings count as equal. */
export function storedNameMatcher(typed: string): (stored: string) => boolean {
  const composed = typed.normalize('NFC')
  return (stored) => stored.normalize('NFC') === composed
}
