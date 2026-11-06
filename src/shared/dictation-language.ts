import type { SpeechModelType } from './speech-types'

export const DICTATION_LANGUAGE_AUTO = 'auto'

// OpenAI's documented transcription languages (ISO-639-1); each is also a Whisper language token.
export const DICTATION_LANGUAGES: readonly string[] = [
  'af',
  'ar',
  'az',
  'be',
  'bg',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'fa',
  'fi',
  'fr',
  'gl',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'kk',
  'kn',
  'ko',
  'lt',
  'lv',
  'mi',
  'mk',
  'mr',
  'ms',
  'ne',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'th',
  'tl',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh'
]

// SenseVoice refuses to load with any other code.
const SENSE_VOICE_LANGUAGES: readonly string[] = ['en', 'ja', 'ko', 'zh']

/** Languages a model can be told to expect; null when it ignores the setting. */
export function dictationLanguagesFor(type: SpeechModelType): readonly string[] | null {
  switch (type) {
    case 'whisper':
    case 'openai':
      return DICTATION_LANGUAGES
    case 'senseVoice':
      return SENSE_VOICE_LANGUAGES
    default:
      return null
  }
}

/** The code to send the engine, or undefined to let it detect the language itself. */
export function engineDictationLanguage(
  type: SpeechModelType,
  setting: string | undefined
): string | undefined {
  return setting && dictationLanguagesFor(type)?.includes(setting) ? setting : undefined
}
