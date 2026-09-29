import type { SpeechModelProvider, VoiceSettings } from '../../../../shared/speech-types'

export type CloudTranscriptionProvider = Exclude<SpeechModelProvider, 'local'>

export function getCloudTranscriptionProviderLabel(provider: CloudTranscriptionProvider): string {
  return provider === 'openai' ? 'OpenAI' : 'OpenRouter'
}

export function cloudTranscriptionConfiguredUpdate(
  provider: CloudTranscriptionProvider,
  configured: boolean
): Partial<VoiceSettings> {
  return provider === 'openai'
    ? { openAiApiKeyConfigured: configured }
    : { openRouterApiKeyConfigured: configured }
}

export function getCloudTranscriptionKeyApi(provider: CloudTranscriptionProvider) {
  const speech = window.api.speech
  return provider === 'openai'
    ? {
        getStatus: () => speech.getOpenAiApiKeyStatus(),
        save: (key: string) => speech.saveOpenAiApiKey(key),
        clear: () => speech.clearOpenAiApiKey()
      }
    : {
        getStatus: () => speech.getOpenRouterApiKeyStatus(),
        save: (key: string) => speech.saveOpenRouterApiKey(key),
        clear: () => speech.clearOpenRouterApiKey()
      }
}
