import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { DictationState, SpeechModelState } from '../../../../../shared/speech-types'
import type { DictationTranscriptSnapshot } from '../../../../../shared/dictation-transcript'

export type DictationLiveText = Pick<DictationTranscriptSnapshot, 'committed' | 'tentative'>

export const NO_DICTATION_LIVE_TEXT: DictationLiveText = { committed: '', tentative: '' }

export type DictationSlice = {
  dictationState: DictationState
  /** The current session's words so far; committed ones have already been inserted. */
  liveText: DictationLiveText
  activeModelId: string | null
  modelStates: SpeechModelState[]
  setDictationState: (state: DictationState) => void
  setLiveText: (text: DictationLiveText) => void
  setActiveModelId: (id: string | null) => void
  setModelStates: (states: SpeechModelState[]) => void
  refreshModelStates: () => Promise<void>
}

function sameSpeechModelState(a: SpeechModelState, b: SpeechModelState): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.progress === b.progress &&
    a.error === b.error &&
    a.needsUpdate === b.needsUpdate
  )
}

// Replies allocate fresh arrays; preserve unchanged identity or every model refresh rerenders subscribers/menu.
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
    liveText: NO_DICTATION_LIVE_TEXT,
    activeModelId: null,
    modelStates: [],

    setDictationState: (state) => set({ dictationState: state }),
    setLiveText: (liveText) => set({ liveText }),
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
