export type SpeechModelType = 'transducer' | 'paraformer' | 'whisper' | 'openai'
export type SpeechModelProvider = 'local' | 'openai'

export type ModelingUnit = 'bpe' | 'cjkchar' | 'cjkchar+bpe'

export type SpeechModelManifest = {
  id: string
  label: string
  description: string
  type: SpeechModelType
  provider: SpeechModelProvider
  language: string
  sizeBytes?: number
  downloadUrl?: string
  archiveSha256?: string
  archiveFormat?: 'tar.bz2'
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
  // Why: the mesh Kokoro voice the desktop speaks replies in. Persisted with
  // the rest of VoiceSettings so the choice survives a restart and so the
  // desktop + mobile pickers agree on a single source of truth for the field.
  // Mirrors mobile's `orca:kokoroVoice` AsyncStorage key; mobile cannot import
  // this type so the parity is asserted by tests on each side.
  kokoroVoice: string
}
