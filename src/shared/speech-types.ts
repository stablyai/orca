export type SpeechModelType =
  | 'transducer'
  | 'paraformer'
  | 'whisper'
  | 'senseVoice'
  | 'nemo-ctc'
  | 'openai'
export type SpeechModelProvider = 'local' | 'openai'

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
  /** Retired: never offered for selection, and a saved selection moves to this model on load. */
  replacedBy?: string
  /** Codes the engine accepts (others crash or fail to load it); absent when it ignores the setting. */
  dictationLanguages?: readonly string[]
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

/** Desktop audio posted from the preload straight to the speech process; 'end' follows the last frame. */
export type SpeechAudioPortMessage =
  | { type: 'feed'; samples: Float32Array; sampleRate: number }
  | { type: 'end' }

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

// Auto: holding the shortcut records until release, a tap toggles.
export type DictationMode = 'auto' | 'hold' | 'toggle'

export type VoiceSettings = {
  enabled: boolean
  sttModel: string
  modelsDir: string
  /** 'auto' or an ISO-639-1 code. Not `language`: its stored 'en' default never came from the user. */
  dictationLanguage: string
  dictationMode: DictationMode
  /** Drops "um", "uh" and their equivalents in the dictation language before text is inserted. */
  removeFillerWords: boolean
  terminalConfirmBeforeInsert: boolean
  userModels: UserModelConfig[]
  openAiApiKeyConfigured: boolean
  /** null = system default input device */
  microphoneDeviceId: string | null
  /** Cached label for display when the preferred device is unplugged */
  microphoneDeviceLabel: string | null
  /** Minutes an idle on-device model stays loaded; 0 unloads after each dictation, null never unloads. */
  unloadModelAfterMinutes: number | null
}
