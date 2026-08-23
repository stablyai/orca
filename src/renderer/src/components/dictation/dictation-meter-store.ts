import { e2eConfig } from '@/lib/e2e-config'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  DEFAULT_DICTATION_METER,
  dictationMeterStatesEqual,
  type DictationMeterState
} from './dictation-audio-meter'

const dictationMeterStore = createStore<DictationMeterState>(() => DEFAULT_DICTATION_METER)

export function publishDictationMeter(meter: DictationMeterState): void {
  if (!dictationMeterStatesEqual(dictationMeterStore.getState(), meter)) {
    dictationMeterStore.setState(meter, true)
  }
}

export function resetDictationMeter(): void {
  dictationMeterStore.setState(DEFAULT_DICTATION_METER, true)
}

export function useDictationMeter(): DictationMeterState {
  return useStore(dictationMeterStore, (state) => state)
}

if (e2eConfig.exposeStore && typeof window !== 'undefined') {
  const testWindow = window as unknown as Record<string, unknown>
  testWindow.__dictationMeterE2E = { publish: publishDictationMeter }
}
