import { createStore } from 'zustand/vanilla'
import {
  createRuntimeDetectedAgentsSlice,
  type RuntimeDetectedAgentsStoreState
} from './runtime-detected-agents'
import { createRuntimeAgentOwnerTestState } from './runtime-detected-agents.test-fixture'
import { createRuntimeStatusSlice } from './runtime-status'
import type { RuntimeStatusStoreState } from './runtime-status-types'

type RuntimeAgentPairingStoreState = RuntimeStatusStoreState & RuntimeDetectedAgentsStoreState

export function createRuntimeDetectedAgentsPairingTestStore() {
  return createStore<RuntimeAgentPairingStoreState>()((...args) => ({
    ...createRuntimeStatusSlice(...args),
    ...createRuntimeDetectedAgentsSlice(...args),
    ...createRuntimeAgentOwnerTestState(),
    clientHostedBrowserCloseIntentsByEnvironment: {},
    clearClientHostedBrowserCloseIntents: () => {
      throw new Error('Agent-detection pairing must not replay browser close intents')
    }
  }))
}
