/**
 * Suggested language codes for the custom speech endpoint field.
 *
 * These are *suggestions only* — the field stays free-text because the set of
 * accepted codes is model/server specific and no single list covers every
 * OpenAI-compatible server. Notably `yue` (Cantonese) and `haw` (Hawaiian) are
 * ISO-639-3 three-letter codes that a strict ISO-639-1 dropdown would exclude.
 *
 * Values are the codes Whisper/faster-whisper expects in the multipart
 * `language` field; the label is the English display name. `''` means
 * auto-detect (the server decides).
 */
export type SpeechLanguageOption = {
  value: string
  label: string
}

export const SPEECH_LANGUAGE_OPTIONS: SpeechLanguageOption[] = [
  { value: '', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese (Mandarin)' },
  { value: 'yue', label: 'Cantonese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'th', label: 'Thai' },
  { value: 'vi', label: 'Vietnamese' },
  { value: 'id', label: 'Indonesian' },
  { value: 'ms', label: 'Malay' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'tr', label: 'Turkish' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'sv', label: 'Swedish' },
  { value: 'da', label: 'Danish' },
  { value: 'no', label: 'Norwegian' },
  { value: 'fi', label: 'Finnish' },
  { value: 'cs', label: 'Czech' },
  { value: 'el', label: 'Greek' },
  { value: 'he', label: 'Hebrew' },
  { value: 'fa', label: 'Persian' }
]

export function filterSpeechLanguageOptions(query: string): SpeechLanguageOption[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return SPEECH_LANGUAGE_OPTIONS
  }
  return SPEECH_LANGUAGE_OPTIONS.filter(
    (option) =>
      option.value.toLowerCase().includes(normalized) ||
      option.label.toLowerCase().includes(normalized)
  )
}
