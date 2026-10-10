import type { SecretAtRestProtection } from './secret-at-rest-protection'

export const CLOUD_SPEECH_PROVIDER_IDS = [
  'openai',
  'soniox',
  'elevenlabs',
  'deepgram',
  'gemini',
  'groq',
  'mistral'
] as const

export type CloudSpeechProviderId = (typeof CLOUD_SPEECH_PROVIDER_IDS)[number]

export type CloudSpeechProviderInfo = {
  id: CloudSpeechProviderId
  label: string
  description: string
  /** Where the user creates a key; shown as a "Get API key" link. */
  keyUrl: string
  keyPlaceholder: string
}

// Why: one ordered list feeds the desktop pane, the mobile cabinet and the host catalog, so a
// provider added here shows up everywhere with the same copy.
export const CLOUD_SPEECH_PROVIDERS: readonly CloudSpeechProviderInfo[] = [
  {
    id: 'soniox',
    label: 'Soniox',
    description: 'Real-time streaming with live captions in 60+ languages.',
    keyUrl: 'https://console.soniox.com/',
    keyPlaceholder: 'Soniox API key'
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'Scribe models in 99 languages, real-time or batch.',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    keyPlaceholder: 'sk_…'
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    description: 'Nova-3 real-time streaming with low latency.',
    keyUrl: 'https://console.deepgram.com/',
    keyPlaceholder: 'Deepgram API key'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini multimodal models transcribe the whole recording at once.',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'Gemini API key'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o transcription models.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…'
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Whisper Large v3 on Groq hardware: very fast batch transcription.',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_…'
  },
  {
    id: 'mistral',
    label: 'Mistral',
    description: 'Voxtral transcription models.',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyPlaceholder: 'Mistral API key'
  }
]

/** Desktop IPC view of one provider's stored key; the key itself never crosses IPC back. */
export type CloudSpeechKeyStatus = {
  providerId: CloudSpeechProviderId
  configured: boolean
  hint: string | null
  protection: SecretAtRestProtection | null
}

export type CloudSpeechKeyTestResult = {
  ok: boolean
  message: string | null
}

export function isCloudSpeechProviderId(value: unknown): value is CloudSpeechProviderId {
  return CLOUD_SPEECH_PROVIDER_IDS.some((id) => id === value)
}

export function getCloudSpeechProvider(id: CloudSpeechProviderId): CloudSpeechProviderInfo {
  const info = CLOUD_SPEECH_PROVIDERS.find((provider) => provider.id === id)
  if (!info) {
    throw new Error(`Unknown cloud speech provider: ${id}`)
  }
  return info
}

// Why: a wrapped paste leaves CR/LF inside the key; header errors would then echo key fragments.
const WELL_FORMED_CLOUD_SPEECH_API_KEY = /^[\x21-\x7e]+$/

export const MALFORMED_CLOUD_SPEECH_API_KEY_MESSAGE =
  'API key contains spaces, line breaks, or other invalid characters.'

/** Printable ASCII with no inner whitespace once the ends are trimmed. */
export function isWellFormedCloudSpeechApiKey(apiKey: string): boolean {
  return WELL_FORMED_CLOUD_SPEECH_API_KEY.test(apiKey.trim())
}
