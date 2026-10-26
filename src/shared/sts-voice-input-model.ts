import type { VoiceSettings } from './speech-types'

const STREAMING_LANGUAGES: Record<string, readonly string[]> = {
  'zipformer-streaming-korean': ['ko'],
  'zipformer-streaming-en-20m': ['en'],
  'zipformer-streaming-zh-14m': ['zh'],
  'zipformer-bilingual-zh-en': ['zh', 'en'],
  'paraformer-bilingual-zh-en': ['zh', 'en']
}

export function supportsVoiceConversationModel(modelId: string, language: string): boolean {
  return (
    modelId === 'elevenlabs-scribe-v2-realtime' ||
    STREAMING_LANGUAGES[modelId]?.includes(language.toLowerCase().split(/[-_]/)[0]) === true
  )
}

export function supportsVoiceConversation(
  settings: VoiceSettings | undefined,
  language: string
): boolean {
  if (!settings?.enabled) {
    return false
  }
  if (settings.sttModel === 'elevenlabs-scribe-v2-realtime') {
    return settings.elevenLabsApiKeyConfigured === true
  }
  return supportsVoiceConversationModel(settings.sttModel, language)
}
