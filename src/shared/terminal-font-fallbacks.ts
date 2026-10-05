export const MAX_TERMINAL_FONT_FALLBACKS = 32

export function normalizeTerminalFontFallbacks(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      continue
    }
    const fontFamily = candidate.trim()
    const key = fontFamily.toLowerCase()
    if (!fontFamily || seen.has(key)) {
      continue
    }
    seen.add(key)
    normalized.push(fontFamily)
    if (normalized.length === MAX_TERMINAL_FONT_FALLBACKS) {
      break
    }
  }
  return normalized
}
