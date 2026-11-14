import type {
  SpeechModelManifest,
  SpeechModelState,
  VoiceSettings
} from '../../../../shared/speech-types'

export type SpeechModelUpdateTarget = {
  /** The model to download: the selection itself. */
  model: SpeechModelManifest
  /** The retired model the selection replaced on load, still on disk. */
  retired?: SpeechModelManifest
}

/** Whether the engine change left the selected local model needing a download, and why. */
export function findSpeechModelUpdateTarget(
  voice: Pick<VoiceSettings, 'enabled' | 'sttModel'>,
  catalog: readonly SpeechModelManifest[],
  states: readonly SpeechModelState[]
): SpeechModelUpdateTarget | null {
  const model = catalog.find((m) => m.id === voice.sttModel)
  if (!voice.enabled || !model || model.provider !== 'local') {
    return null
  }
  const stateOf = (id: string): SpeechModelState | undefined => states.find((s) => s.id === id)
  const selected = stateOf(model.id)
  if (selected?.needsUpdate) {
    return { model }
  }
  if (selected?.status === 'ready') {
    return null
  }
  // Settings load already moved the selection off the retired id, so find it by its files.
  const retired = catalog.find(
    (m) => m.replacedBy === model.id && stateOf(m.id)?.status === 'ready'
  )
  if (retired) {
    return { model, retired }
  }
  // A download in flight has no needsUpdate, yet the model still can't dictate; the pill shows its progress.
  return isSpeechModelDownloading(selected) ? { model } : null
}

export function isSpeechModelDownloading(state: SpeechModelState | undefined): boolean {
  return state?.status === 'downloading' || state?.status === 'extracting'
}

/** Only a ready model with no pending update is known to dictate. */
export function isSpeechModelReady(state: SpeechModelState | undefined): boolean {
  return state?.status === 'ready' && !state.needsUpdate
}
