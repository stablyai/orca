import { createStore } from 'zustand/vanilla'
import { createPairedTerminalTabCloseIntentSlice } from './paired-terminal-tab-close-intent-actions'

/** The held-close slice alone, for suites that mock the app store around it. */
export function createPairedTerminalTabCloseIntentTestStore() {
  return createStore(createPairedTerminalTabCloseIntentSlice)
}

export type PairedTerminalTabCloseIntentTestStore = ReturnType<
  typeof createPairedTerminalTabCloseIntentTestStore
>
