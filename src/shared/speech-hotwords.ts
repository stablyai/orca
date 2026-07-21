export const MAX_SPEECH_HOTWORDS = 200
export const MAX_SPEECH_HOTWORD_LENGTH = 120

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
    if (!word || word.length > MAX_SPEECH_HOTWORD_LENGTH || /[\r\n]/.test(word)) {
      continue
    }
    const key = word.toLocaleLowerCase()
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
