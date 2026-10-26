import type { SupportedUiLocale } from './ui-locale'

export type SpeechModelType =
  | 'transducer'
  | 'paraformer'
  | 'whisper'
  | 'senseVoice'
  | 'nemo-ctc'
  | 'openai'
  | 'elevenlabs'
export type SpeechModelProvider = 'local' | 'openai' | 'elevenlabs'

export type ModelingUnit = 'bpe' | 'cjkchar' | 'cjkchar+bpe'

export type SpeechModelDownloadFile = {
  name: string
  url: string
  sizeBytes: number
  sha256: string
}

export type SpeechModelManifest = {
  id: string
  label: string
  description: string
  type: SpeechModelType
  provider: SpeechModelProvider
  language: string
  sizeBytes?: number
  downloadFiles?: SpeechModelDownloadFile[]
  files?: string[]
  sampleRate: number
  streaming: boolean
  modelingUnit?: ModelingUnit
  recommended?: boolean
}

export type SpeechModelStatus = 'not-downloaded' | 'downloading' | 'extracting' | 'ready' | 'error'

export type SpeechModelState = {
  id: string
  status: SpeechModelStatus
  progress?: number
  error?: string
}

export type SpeechTranscriptEvent = {
  text: string
  sessionId: string
}

export type SpeechLifecycleEvent = {
  sessionId: string
}

export type SpeechErrorEvent = {
  error: string
  sessionId: string
}

export type DictationState = 'idle' | 'starting' | 'listening' | 'stopping' | 'error'

export type UserModelConfig = {
  id: string
  type: SpeechModelType
  dir: string
  sampleRate?: number
}

export type DictationMode = 'toggle' | 'hold'

export type VoiceSettings = {
  enabled: boolean
  sttModel: string
  modelsDir: string
  language: string
  dictationMode: DictationMode
  terminalConfirmBeforeInsert: boolean
  userModels: UserModelConfig[]
  openAiApiKeyConfigured: boolean
  elevenLabsApiKeyConfigured?: boolean
  ttsProvider?: 'local' | 'elevenlabs'
  conversationLanguage?: SupportedUiLocale
  localVoiceUri?: string
  elevenLabsVoiceId?: string
  elevenLabsTtsModel?: 'eleven_flash_v2_5' | 'eleven_multilingual_v2'
  /** null = system default input device */
  microphoneDeviceId: string | null
  /** Cached label for display when the preferred device is unplugged */
  microphoneDeviceLabel: string | null
}

export type ElevenLabsVoice = { id: string; name: string }

export type ElevenLabsAudioChunk = { requestId: string; bytes: Uint8Array }

export type ElevenLabsSpeechRequest = {
  requestId: string
  text: string
  voiceId: string
  modelId: 'eleven_flash_v2_5' | 'eleven_multilingual_v2'
}
