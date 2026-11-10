import { isOfferedSpeechModel } from './speech-model-retirement'
import { speechModelQuality } from './speech-model-quality'
import type { SpeechModelManifest } from './speech-types'

export type SpeechModelSuggestionOptions = {
  /** The user's current pick, which wins while it is still offered, even with its files gone. */
  selectedModelId?: string
  /** True on a Mac with Apple silicon and the GPU on, where the most accurate model is fast enough. */
  favorAccuracy: boolean
}

/**
 * The on-device model one-click setup offers for a language, or undefined when none handles it.
 * Favoring accuracy, it is the best measured model. Otherwise it is the fast pick: the model the
 * catalog names for the language, then the recommended default, then the best measured model.
 */
export function suggestSpeechModel(
  catalog: readonly SpeechModelManifest[],
  language: string,
  { selectedModelId, favorAccuracy }: SpeechModelSuggestionOptions
): SpeechModelManifest | undefined {
  const offered = catalog.filter((m) => m.provider === 'local' && isOfferedSpeechModel(m))
  const selected = offered.find((m) => m.id === selectedModelId)
  if (selected) {
    return selected
  }
  if (!favorAccuracy) {
    const named = offered.find((m) => m.suggestedFor?.includes(language))
    if (named) {
      return named
    }
    const recommended = offered.find((m) => m.recommended)
    if (recommended?.languages.includes(language)) {
      return recommended
    }
  }
  let best: { model: SpeechModelManifest; percent: number } | undefined
  for (const model of offered) {
    const quality = speechModelQuality(model, language)
    if (quality.kind === 'rated' && (!best || quality.errorRate.percent < best.percent)) {
      best = { model, percent: quality.errorRate.percent }
    }
  }
  return best?.model ?? offered.find((m) => m.languages.includes(language))
}
