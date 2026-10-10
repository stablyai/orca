import type { CloudSpeechProviderId } from './cloud-speech-providers'

export type SpeechModelType =
  | 'transducer'
  | 'paraformer'
  | 'whisper'
  | 'senseVoice'
  | 'nemo-ctc'
  | 'openai'
  | 'cloud'
export type SpeechModelProvider = 'local' | CloudSpeechProviderId

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
  /** Cloud model that transcribes while audio streams in and emits live partials. */
  realtime?: boolean
  /** Language hints the model accepts: 'any', a list of ISO 639-1 codes, or absent when it picks its own. */
  transcriptionLanguages?: 'any' | readonly string[]
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
  /** Spoken-language hint for cloud models: 'auto' or an ISO 639-1 code. */
  transcriptionLanguage: string
  /** null = system default input device */
  microphoneDeviceId: string | null
  /** Cached label for display when the preferred device is unplugged */
  microphoneDeviceLabel: string | null
}
