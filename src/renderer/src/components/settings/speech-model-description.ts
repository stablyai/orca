import type { SpeechModelManifest } from '../../../../shared/speech-types'
import { translate } from '@/i18n/i18n'

const DESCRIPTIONS: Record<string, () => string> = {
  'parakeet-tdt-0.6b-v3-int8': () =>
    translate(
      'settings.voice.modelDescriptions.parakeetV3',
      'Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.'
    ),
  'parakeet-tdt-0.6b-v2-int8': () =>
    translate(
      'settings.voice.modelDescriptions.parakeetV2',
      'English only. Faster than v3 with similar accuracy. Punctuation and capitalization.'
    ),
  'zipformer-bilingual-zh-en': () =>
    translate(
      'settings.voice.modelDescriptions.zipformerBilingual',
      'Chinese + English with code-switching. Low-latency real-time streaming.'
    ),
  'paraformer-bilingual-zh-en': () =>
    translate(
      'settings.voice.modelDescriptions.paraformerBilingual',
      'Chinese (Mandarin + dialects) + English. Strong on accented and regional Chinese.'
    ),
  'zipformer-streaming-en-20m': () =>
    translate(
      'settings.voice.modelDescriptions.zipformerStreamingEn',
      'English only. Lightweight 20M-param model, good balance of speed and size.'
    ),
  'zipformer-streaming-zh-14m': () =>
    translate(
      'settings.voice.modelDescriptions.zipformerStreamingZh',
      'Chinese only. Ultra-lightweight 14M-param model, ideal for low-resource devices.'
    ),
  'zipformer-streaming-korean': () =>
    translate(
      'settings.voice.modelDescriptions.zipformerStreamingKo',
      'Korean only. Low-latency real-time streaming.'
    ),
  'parakeet-tdt-ctc-0.6b-ja-int8': () =>
    translate(
      'settings.voice.modelDescriptions.parakeetJa',
      'Japanese only. Trained on 35k+ hours of natural speech. Punctuation included.'
    ),
  'whisper-tiny': () =>
    translate(
      'settings.voice.modelDescriptions.whisperTiny',
      '90+ languages. Lower accuracy than Parakeet but broadest language coverage.'
    ),
  'sense-voice-zh-en-ja-ko-yue': () =>
    translate(
      'settings.voice.modelDescriptions.senseVoice',
      'Chinese, English, Japanese, Korean, and Cantonese with automatic language detection.'
    ),
  'openai-gpt-4o-mini-transcribe': () =>
    translate(
      'settings.voice.modelDescriptions.gpt4oMiniTranscribe',
      'Cloud transcription with strong accuracy and low cost. Requires an OpenAI API key.'
    ),
  'openai-gpt-4o-transcribe': () =>
    translate(
      'settings.voice.modelDescriptions.gpt4oTranscribe',
      'Cloud transcription with higher accuracy. Requires an OpenAI API key.'
    )
}

/** Main's catalog arrives in English over IPC; unknown ids from a newer main keep it. */
export function speechModelDescription(manifest: SpeechModelManifest): string {
  return Object.hasOwn(DESCRIPTIONS, manifest.id)
    ? DESCRIPTIONS[manifest.id]()
    : manifest.description
}
