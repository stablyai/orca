import { createDictationDictionary, type DictationTerm } from './dictation-dictionary'
import { engineDictationLanguage } from './dictation-language'
import { removeFillerWords } from './dictation-filler-words'
import type { SpeechModelManifest, VoiceSettings } from './speech-types'

export type DictationTextSettings = Pick<
  VoiceSettings,
  'dictationLanguage' | 'removeFillerWords'
> & {
  /** AI cleanup's correction cue, which filler removal leaves for cleanup to act on. */
  correctionWord?: string
}

type DictationTextModel = Pick<SpeechModelManifest, 'language' | 'dictationLanguages'>

/** The languages the dictated text is in: a single-language model's own, else the one the engine is told; undefined when unknown. */
function dictatedTextLanguages(
  model: DictationTextModel | undefined,
  setting: string | undefined
): string[] | undefined {
  if (!model) {
    return undefined
  }
  if (model.language !== 'multilingual') {
    // Bilingual models name both, as in 'zh-en'.
    return model.language.split('-')
  }
  // The Voice pane disables a setting the model ignores, so a stale one says nothing about what was spoken.
  const language = engineDictationLanguage(model, setting)
  return language ? [language] : undefined
}

/** The passes dictated text goes through before anyone sees it, or null when every pass is off. */
export function createDictationTextPipeline(
  model: DictationTextModel | undefined,
  settings: Partial<DictationTextSettings> | undefined,
  terms?: readonly DictationTerm[]
): ((text: string) => string) | null {
  const languages = dictatedTextLanguages(model, settings?.dictationLanguage)
  const dropFillers =
    settings?.removeFillerWords === false
      ? null
      : (text: string) => removeFillerWords(text, languages, settings?.correctionWord)
  const spellTerms = createDictationDictionary(terms)
  if (!dropFillers || !spellTerms) {
    return dropFillers ?? spellTerms
  }
  // Terms last, so a filler removed at a sentence start can't recapitalize a lowercase term like "pnpm".
  return (text) => spellTerms(dropFillers(text))
}
