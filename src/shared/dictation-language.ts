import type { SpeechModelManifest } from './speech-types'

export const DICTATION_LANGUAGE_AUTO = 'auto'

// OpenAI's documented transcription languages (ISO-639-1); each is also a Whisper language token.
const DICTATION_LANGUAGE_CODES =
  'af ar az be bg bs ca cs cy da de el en es et fa fi fr gl he hi hr hu hy id is it ja kk kn ko lt lv mi mk mr ms ne nl no pl pt ro ru sk sl sr sv sw ta th tl tr uk ur vi zh'
export const DICTATION_LANGUAGES: readonly string[] = DICTATION_LANGUAGE_CODES.split(' ')

// SenseVoice refuses to load with any other code.
export const SENSE_VOICE_DICTATION_LANGUAGES: readonly string[] = ['en', 'ja', 'ko', 'yue', 'zh']

// Whisper's language tokens; large-v3 models also have Cantonese.
export const WHISPER_LANGUAGES: readonly string[] =
  'af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu haw ha he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh'.split(
    ' '
  )

// The 25 European languages on Parakeet TDT v3's model card; it ignores a language hint.
export const PARAKEET_V3_LANGUAGES: readonly string[] =
  'bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk'.split(' ')

// Nemotron 3.5's locales (ko-KR, zh-CN, ...) by ISO-639-1 language; the recognizer sends the first matching locale.
export const NEMOTRON_DICTATION_LANGUAGES: readonly string[] =
  'ar bg cs da de en es et fi fr hi hr hu it ja ko nl pl pt ro ru sk sv tr uk vi zh'.split(' ')

/** The code to send the engine, or undefined to let it detect the language itself. */
export function engineDictationLanguage(
  model: Pick<SpeechModelManifest, 'dictationLanguages'>,
  setting: string | undefined
): string | undefined {
  return setting && model.dictationLanguages?.includes(setting) ? setting : undefined
}
