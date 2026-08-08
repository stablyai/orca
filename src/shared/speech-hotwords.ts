export const MAX_SPEECH_HOTWORDS = 200
export const MAX_SPEECH_HOTWORD_LENGTH = 120

function containsUnsupportedCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029 || character === ':') {
      return true
    }
  }
  return false
}

export function normalizeSpeechHotwords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const word = item.trim()
    if (!word || word.length > MAX_SPEECH_HOTWORD_LENGTH || containsUnsupportedCharacters(word)) {
      continue
    }
    const key = word.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    normalized.push(word)
    if (normalized.length >= MAX_SPEECH_HOTWORDS) {
      break
    }
  }
  return normalized
}
