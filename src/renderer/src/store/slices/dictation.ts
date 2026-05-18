import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DictationState, SpeechModelState } from '../../../../shared/speech-types'

export type DictationSlice = {
  dictationState: DictationState
  partialTranscript: string
  activeModelId: string | null
  modelStates: SpeechModelState[]
  setDictationState: (state: DictationState) => void
  setPartialTranscript: (text: string) => void
  setActiveModelId: (id: string | null) => void
  setModelStates: (states: SpeechModelState[]) => void
  refreshModelStates: () => Promise<void>
}

export const createDictationSlice: StateCreator<AppState, [], [], DictationSlice> = (set) => ({
  dictationState: 'idle',
  partialTranscript: '',
  activeModelId: null,
  modelStates: [],

  setDictationState: (state) => set({ dictationState: state }),
  setPartialTranscript: (text) => set({ partialTranscript: text }),
  setActiveModelId: (id) => set({ activeModelId: id }),
  setModelStates: (states) => set({ modelStates: states }),

  refreshModelStates: async () => {
    try {
      const states = await window.api.speech.getModelStates()
      set({ modelStates: states })
    } catch (err) {
      console.error('Failed to fetch model states:', err)
    }
  }
})
