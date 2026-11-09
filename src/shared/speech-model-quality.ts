import { DICTATION_LANGUAGE_AUTO } from './dictation-language'
import type { SpeechModelErrorRate, SpeechModelManifest } from './speech-types'

/** 5 = Excellent, 4 = Very good, 3 = Good, 2 = Fair, 1 = Poor. */
export type SpeechModelQualityTier = 1 | 2 | 3 | 4 | 5

export type SpeechModelQuality =
  | { kind: 'unsupported' }
  | { kind: 'unmeasured' }
  | { kind: 'rated'; tier: SpeechModelQualityTier; errorRate: SpeechModelErrorRate }

// Highest error % each tier allows, best tier first.
const TIER_CEILINGS: readonly (readonly [percent: number, tier: SpeechModelQualityTier])[] = [
  [3, 5],
  [6, 4],
  [10, 3],
  [20, 2]
]

function tierFor(percent: number): SpeechModelQualityTier {
  return TIER_CEILINGS.find(([ceiling]) => percent <= ceiling)?.[1] ?? 1
}

/** The language ratings follow: the dictation language, or the system's when that is Auto-detect. */
export function speechModelRatingLanguage(
  dictationLanguage: string | undefined,
  systemLocale: string | undefined
): string | undefined {
  if (dictationLanguage && dictationLanguage !== DICTATION_LANGUAGE_AUTO) {
    return dictationLanguage
  }
  return systemLocale?.split(/[-_]/)[0]?.toLowerCase() || undefined
}

export function speechModelQuality(
  model: Pick<SpeechModelManifest, 'languages' | 'errorRates'>,
  language: string
): SpeechModelQuality {
  if (!model.languages.includes(language)) {
    return { kind: 'unsupported' }
  }
  const errorRate = model.errorRates?.find((rate) => rate.language === language)
  return errorRate
    ? { kind: 'rated', tier: tierFor(errorRate.percent), errorRate }
    : { kind: 'unmeasured' }
}
