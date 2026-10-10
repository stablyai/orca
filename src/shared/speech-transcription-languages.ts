export const AUTO_TRANSCRIPTION_LANGUAGE = 'auto'

export type SpeechTranscriptionLanguage = { code: string; label: string }

// Why: a short list of widely supported ISO 639-1 codes keeps the picker scannable; providers that
// cannot honour a hint ignore it, and 'auto' leaves detection to the provider.
export const SPEECH_TRANSCRIPTION_LANGUAGES: readonly SpeechTranscriptionLanguage[] = [
  { code: AUTO_TRANSCRIPTION_LANGUAGE, label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'pl', label: 'Polish' },
  { code: 'nl', label: 'Dutch' },
  { code: 'cs', label: 'Czech' },
  { code: 'sv', label: 'Swedish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' }
]

// Why: Mistral Voxtral transcribes these 13 languages; any other hint would be rejected or mis-decoded.
export const VOXTRAL_TRANSCRIPTION_LANGUAGES: readonly string[] = [
  'en',
  'zh',
  'hi',
  'es',
  'ar',
  'fr',
  'pt',
  'ru',
  'de',
  'ja',
  'ko',
  'it',
  'nl'
]

/** Returns the language to send to a provider, or undefined to let it auto-detect. */
export function resolveTranscriptionLanguageHint(value: string | undefined): string | undefined {
  if (!value || value === AUTO_TRANSCRIPTION_LANGUAGE) {
    return undefined
  }
  return /^[a-z]{2,3}$/.test(value) ? value : undefined
}

/** Which picker languages a model honours: every code, a subset, or none when the model picks its own. */
export function getModelTranscriptionLanguages(
  supported: 'any' | readonly string[] | undefined
): string[] | null {
  if (supported === undefined) {
    return null
  }
  const codes = SPEECH_TRANSCRIPTION_LANGUAGES.map((entry) => entry.code).filter(
    (code) => code !== AUTO_TRANSCRIPTION_LANGUAGE
  )
  return supported === 'any' ? codes : codes.filter((code) => supported.includes(code))
}

/** The hint to send for this model, or undefined to let it auto-detect. */
export function resolveModelLanguageHint(
  supported: 'any' | readonly string[] | undefined,
  language: string | undefined
): string | undefined {
  const hint = resolveTranscriptionLanguageHint(language)
  if (!hint) {
    return undefined
  }
  return getModelTranscriptionLanguages(supported)?.includes(hint) ? hint : undefined
}
