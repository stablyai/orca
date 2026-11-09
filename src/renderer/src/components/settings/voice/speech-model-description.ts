import type { SpeechModelManifest } from '../../../../../shared/speech-types'
import { translate } from '@/i18n/i18n'

// Models transcribe-cpp can't run; their users moved to SenseVoice or Parakeet.
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
  'whisper-large-v3-turbo': () =>
    translate(
      'settings.voice.modelDescriptions.whisperLargeV3Turbo',
      'Best accuracy for Japanese, Korean, and Chinese, and 90+ languages. Slower than Parakeet.'
    ),
  'sense-voice-zh-en-ja-ko-yue': () =>
    translate(
      'settings.voice.modelDescriptions.senseVoice',
      'Chinese, English, Japanese, Korean, and Cantonese with automatic language detection.'
    ),
  'openai-compatible': () =>
    translate(
      'settings.voice.modelDescriptions.openAiCompatible',
      'Any service with an OpenAI-style transcription API, such as Groq, Mistral or a local server.'
    ),
  'nemotron-3.5-asr-streaming-0.6b': () =>
    translate(
      'settings.voice.modelDescriptions.nemotron',
      'English, Spanish, German and many more languages, with automatic language detection.'
    ),
  'openai-gpt-transcribe': () =>
    translate(
      'settings.voice.modelDescriptions.gptTranscribe',
      'Cloud transcription with high accuracy. Requires an OpenAI API key.'
    )
}

/** Main's catalog arrives in English over IPC; unknown ids from a newer main keep it. */
export function speechModelDescription(manifest: SpeechModelManifest): string {
  return Object.hasOwn(DESCRIPTIONS, manifest.id)
    ? DESCRIPTIONS[manifest.id]()
    : manifest.description
}
