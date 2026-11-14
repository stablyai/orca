import type { SpeechModelManifest } from '../../../../../shared/speech-types'
import type { Translate } from '@/i18n/use-translate'

/** One line on what a model is good at; claims follow the catalog's languages and Orca's speech bench. */
export function speechModelDescription(
  manifest: SpeechModelManifest,
  t: Translate
): string | undefined {
  if (manifest.provider === 'openai') {
    return t('components.settings.voice.models.sendsToOpenAi', 'Sends your audio to OpenAI.')
  }
  if (manifest.provider === 'openai-compatible') {
    return t(
      'components.settings.voice.models.sendsToCompatible',
      'Sends your audio to the service you set up.'
    )
  }
  const languages = manifest.languages.length
  switch (manifest.id) {
    case 'parakeet-tdt-0.6b-v3-int8':
      return t(
        'components.settings.voice.models.about.parakeetV3',
        'Fast. {{languages}} European languages.',
        { languages }
      )
    case 'parakeet-tdt-0.6b-v2-int8':
      return t(
        'components.settings.voice.models.about.parakeetV2',
        'Fast. English only, and the most accurate at it.'
      )
    case 'parakeet-unified-en-0.6b':
      return t(
        'components.settings.voice.models.about.parakeetUnifiedEn',
        'English only. Words appear as you speak.'
      )
    case 'whisper-tiny':
      return t(
        'components.settings.voice.models.about.whisperTiny',
        'Smallest download. Good for trying dictation out.'
      )
    case 'whisper-large-v3-turbo':
      return t(
        'components.settings.voice.models.about.whisperTurbo',
        'Most languages, about 100. Slow without a GPU.'
      )
    case 'sense-voice-zh-en-ja-ko-yue':
      return t(
        'components.settings.voice.models.about.senseVoice',
        'Fast. For Chinese, Japanese and Korean.'
      )
    case 'nemotron-3.5-asr-streaming-0.6b':
      return t(
        'components.settings.voice.models.about.nemotron',
        '{{languages}} languages, including Arabic, Hindi and Japanese.',
        { languages }
      )
    default:
      return undefined
  }
}
