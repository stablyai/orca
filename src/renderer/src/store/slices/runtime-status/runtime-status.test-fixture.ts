import { createStore } from 'zustand/vanilla'
import { createRuntimeStatusSlice } from './create-runtime-status-slice'
import type { RuntimeStatusStoreState } from './runtime-status-types'

export function createRuntimeStatusTestStore() {
  return createStore<RuntimeStatusStoreState>()((...args) => ({
    ...createRuntimeStatusSlice(...args),
    clientHostedBrowserCloseIntentsByEnvironment: {},
    clearClientHostedBrowserCloseIntents: () => {
      throw new Error('Runtime-status catalog tests must not replay browser close intents')
    }
  }))
}
