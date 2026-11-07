import { createStore } from 'zustand/vanilla'
import type { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import {
  createRuntimeDetectedAgentsSlice,
  type RuntimeDetectedAgentsStoreState
} from './runtime-detected-agents'

export function createRuntimeAgentOwnerTestState(): Parameters<typeof getConnectionIdFromState>[0] {
  return { repos: [], worktreesByRepo: {}, folderWorkspaces: [], projectGroups: [] }
}

export function createRuntimeDetectedAgentsTestStore() {
  return createStore<RuntimeDetectedAgentsStoreState>()((...args) => ({
    ...createRuntimeDetectedAgentsSlice(...args),
    ...createRuntimeAgentOwnerTestState()
  }))
}
