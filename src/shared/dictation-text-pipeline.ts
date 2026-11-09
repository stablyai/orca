import { DICTATION_LANGUAGE_AUTO } from './dictation-language'
import { removeFillerWords } from './dictation-filler-words'
import type { SpeechModelManifest, VoiceSettings } from './speech-types'

export type DictationTextSettings = Pick<VoiceSettings, 'dictationLanguage' | 'removeFillerWords'>

/** The languages the dictated text is in: a single-language model's own, else the user's setting; undefined when unknown. */
export function dictatedTextLanguages(
  model: Pick<SpeechModelManifest, 'language'> | undefined,
  setting: string | undefined
): string[] | undefined {
  if (model && model.language !== 'multilingual') {
    // Bilingual models name both, as in 'zh-en'.
    return model.language.split('-')
  }
  return setting && setting !== DICTATION_LANGUAGE_AUTO ? [setting] : undefined
}

/** The passes dictated text goes through before anyone sees it, or null when every pass is off. */
export function createDictationTextPipeline(
  model: Pick<SpeechModelManifest, 'language'> | undefined,
  settings: Partial<DictationTextSettings> | undefined
): ((text: string) => string) | null {
  if (settings?.removeFillerWords === false) {
    return null
  }
  const languages = dictatedTextLanguages(model, settings?.dictationLanguage)
  return (text) => removeFillerWords(text, languages)
}
