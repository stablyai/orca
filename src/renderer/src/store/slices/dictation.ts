import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DictationState, SpeechModelState } from '../../../../shared/speech-types'

/** A message the native chat composer sends at `deadline` unless the user cancels. */
export type PendingDictationAutoSend = { deadline: number }

export type DictationSlice = {
  dictationState: DictationState
  partialTranscript: string
  pendingDictationAutoSend: PendingDictationAutoSend | null
  activeModelId: string | null
  modelStates: SpeechModelState[]
  setDictationState: (state: DictationState) => void
  setPartialTranscript: (text: string) => void
  setPendingDictationAutoSend: (pending: PendingDictationAutoSend | null) => void
  setActiveModelId: (id: string | null) => void
  setModelStates: (states: SpeechModelState[]) => void
  refreshModelStates: () => Promise<void>
}

function sameSpeechModelState(a: SpeechModelState, b: SpeechModelState): boolean {
  return a.id === b.id && a.status === b.status && a.progress === b.progress && a.error === b.error
}

// Why: every getModelStates reply is a fresh array, so without this each no-op
// refresh re-renders every subscriber — including the open speech-model menu.
function resolveModelStates(
  previous: SpeechModelState[],
  next: SpeechModelState[]
): SpeechModelState[] {
  if (previous.length !== next.length) {
    return next
  }
  return previous.every((state, index) => sameSpeechModelState(state, next[index]))
    ? previous
    : next
}

export const createDictationSlice: StateCreator<AppState, [], [], DictationSlice> = (set) => {
  const setModelStates = (states: SpeechModelState[]): void => {
    set((prev) => {
      const modelStates = resolveModelStates(prev.modelStates, states)
      return modelStates === prev.modelStates ? prev : { modelStates }
    })
  }

  return {
    dictationState: 'idle',
    partialTranscript: '',
    pendingDictationAutoSend: null,
    activeModelId: null,
    modelStates: [],

    setDictationState: (state) => set({ dictationState: state }),
    setPartialTranscript: (text) => set({ partialTranscript: text }),
    setPendingDictationAutoSend: (pending) => set({ pendingDictationAutoSend: pending }),
    setActiveModelId: (id) => set({ activeModelId: id }),
    setModelStates,

    refreshModelStates: async () => {
      try {
        setModelStates(await window.api.speech.getModelStates())
      } catch (err) {
        console.error('Failed to fetch model states:', err)
      }
    }
  }
}
