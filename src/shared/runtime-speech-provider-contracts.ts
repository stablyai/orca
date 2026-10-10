import type { CloudSpeechProviderId } from './cloud-speech-providers'

/**
 * One model row in the provider cabinet (`speech.providers.list`).
 *
 * Kept separate from RuntimeSpeechModelSummary: that type's `provider` arm set is pinned by
 * shipped phones, so `speech.models.list` keeps answering local + OpenAI rows only and cloud
 * providers reach new phones through this reply instead.
 */
export type RuntimeSpeechProviderModel = {
  id: string
  label: string
  description: string
  /** Transcribes while audio streams in, so the phone can show live captions. */
  realtime: boolean
  /**
   * Picker languages the model honours; null when it picks its own (on-device models).
   * Optional on the wire: older hosts omit it, and readers then treat every language as accepted.
   */
  languages?: string[] | null
  sizeBytes: number | null
  recommended: boolean
  status: 'ready' | 'not-downloaded' | 'downloading' | 'extracting' | 'error'
  progress: number | null
}

export type RuntimeSpeechProviderSummary = {
  id: 'local' | CloudSpeechProviderId
  kind: 'local' | 'cloud'
  label: string
  description: string
  /** Cloud only: whether the host holds a key. The key itself never leaves the host. */
  keyConfigured: boolean
  /** Cloud only: last characters of the saved key, e.g. "…a1b2", for recognition. */
  keyHint: string | null
  keyUrl: string | null
  keyPlaceholder: string | null
  models: RuntimeSpeechProviderModel[]
}

export type RuntimeSpeechProvidersState = {
  enabled: boolean
  selectedModelId: string
  dictationMode: 'toggle' | 'hold'
  /** 'auto' or an ISO 639-1 code; see SPEECH_TRANSCRIPTION_LANGUAGES. */
  language: string
  providers: RuntimeSpeechProviderSummary[]
}

export type RuntimeSpeechProviderKeyTest = {
  ok: boolean
  /** Provider-facing failure reason with any key material redacted. */
  message: string | null
}

/**
 * Optional live caption on the `speech.dictation.chunk` reply.
 *
 * `text` is the whole transcript so far (committed + in-progress), so a reader replaces rather
 * than appends; `revision` only grows within one dictation, so a reply that arrives late can be
 * discarded. Old hosts omit it and old phones ignore it (remote-wire-compatibility Rule 1).
 */
export type RuntimeDictationCaption = {
  text: string
  revision: number
}

export type RuntimeDictationChunkReply = {
  dictationId: string
  caption?: RuntimeDictationCaption
}

/**
 * Reply to `speech.dictation.finish`.
 *
 * `error` is set when the provider failed but some text was still committed (e.g. a failure
 * during the stop flush, or one already raised on a chunk), so the phone can insert `text`
 * and then report why the rest may be missing. Without text the call rejects instead.
 * Optional on the wire: old hosts omit it and old phones ignore it.
 */
export type RuntimeDictationFinishReply = {
  dictationId: string
  text: string
  error?: string
}
