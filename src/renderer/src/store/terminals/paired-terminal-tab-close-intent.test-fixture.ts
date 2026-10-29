import { createStore } from 'zustand/vanilla'
import {
  createPairedTerminalTabCloseIntentSlice,
  type PairedTerminalTabCloseIntentSlice
} from './paired-terminal-tab-close-intent-actions'
import { withSessionSourceWrites } from '../session-source-write-boundary'

/** The held-close slice alone, for suites that mock the app store around it. */
export function createPairedTerminalTabCloseIntentTestStore() {
  return createStore<PairedTerminalTabCloseIntentSlice>()(
    withSessionSourceWrites<PairedTerminalTabCloseIntentSlice>(
      createPairedTerminalTabCloseIntentSlice,
      true
    )
  )
}

export type PairedTerminalTabCloseIntentTestStore = ReturnType<
  typeof createPairedTerminalTabCloseIntentTestStore
>
