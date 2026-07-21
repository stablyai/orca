import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DictationState, SpeechModelState } from '../../../../shared/speech-types'
import {
  DEFAULT_DICTATION_METER,
  resetDictationMeterState,
  type DictationMeterState
} from '../../components/dictation/dictation-audio-meter'

export type DictationIndicatorNotice = {
  kind: 'error' | 'info'
  message: string
  createdAt: number
}

export type DictationSlice = {
  dictationState: DictationState
  partialTranscript: string
  activeModelId: string | null
  modelStates: SpeechModelState[]
  dictationMeter: DictationMeterState
  dictationNotice: DictationIndicatorNotice | null
  setDictationState: (state: DictationState) => void
  setPartialTranscript: (text: string) => void
  setActiveModelId: (id: string | null) => void
  setModelStates: (states: SpeechModelState[]) => void
  setDictationMeter: (meter: DictationMeterState) => void
  resetDictationMeter: () => void
  setDictationNotice: (notice: DictationIndicatorNotice | null) => void
  clearDictationNotice: () => void
  refreshModelStates: () => Promise<void>
}

export const createDictationSlice: StateCreator<AppState, [], [], DictationSlice> = (set) => ({
  dictationState: 'idle',
  partialTranscript: '',
  activeModelId: null,
  modelStates: [],
  dictationMeter: DEFAULT_DICTATION_METER,
  dictationNotice: null,

  setDictationState: (state) => set({ dictationState: state }),
  setPartialTranscript: (text) => set({ partialTranscript: text }),
  setActiveModelId: (id) => set({ activeModelId: id }),
  setModelStates: (states) => set({ modelStates: states }),
  setDictationMeter: (meter) => set({ dictationMeter: meter }),
  resetDictationMeter: () => set({ dictationMeter: resetDictationMeterState() }),
  setDictationNotice: (notice) => set({ dictationNotice: notice }),
  clearDictationNotice: () => set({ dictationNotice: null }),

  refreshModelStates: async () => {
    try {
      const states = await window.api.speech.getModelStates()
      set({ modelStates: states })
    } catch (err) {
      console.error('Failed to fetch model states:', err)
    }
  }
})
