import type { SpeechModelManifest } from '../../../../../shared/speech-types'
import { translate } from '@/i18n/i18n'

// Models transcribe-cpp can't run; their users moved to SenseVoice or Nemotron.
const retiredForEngine = (): string =>
  translate(
    'settings.voice.modelDescriptions.retiredForEngine',
    'No longer offered: the speech engine can no longer run it. Delete it to free up space.'
  )

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
  'zipformer-bilingual-zh-en': retiredForEngine,
  'paraformer-bilingual-zh-en': retiredForEngine,
  'zipformer-streaming-en-20m': () =>
    translate(
      'settings.voice.modelDescriptions.zipformerStreamingEnRetired',
      'No longer offered: it drops the start of sentences. Delete it to free up space.'
    ),
  'zipformer-streaming-zh-14m': retiredForEngine,
  'zipformer-streaming-korean': retiredForEngine,
  'parakeet-tdt-ctc-0.6b-ja-int8': retiredForEngine,
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
  'nemotron-3.5-asr-streaming-0.6b': () =>
    translate(
      'settings.voice.modelDescriptions.nemotron',
      'Korean, Chinese, Japanese and many more languages, with automatic language detection.'
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
