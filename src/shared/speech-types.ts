export type SpeechModelType = 'transducer' | 'paraformer' | 'whisper'

export type ModelingUnit = 'bpe' | 'cjkchar' | 'cjkchar+bpe'

export type SpeechModelManifest = {
  id: string
  label: string
  description: string
  type: SpeechModelType
  language: string
  sizeBytes: number
  downloadUrl: string
  archiveFormat: 'tar.bz2'
  files: string[]
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
}
