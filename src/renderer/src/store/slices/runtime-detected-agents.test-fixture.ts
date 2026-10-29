import type { Repo } from '../../../../shared/repo-types'
import { createStore } from 'zustand/vanilla'
import type { AppState } from '../types'
import { getDefaultSettings } from '../../../../shared/constants'
import { withSessionSourceTestWrites } from '@/lib/test-support/session-source-test-store'
import type { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { createRuntimeDetectedAgentsSlice } from './runtime-detected-agents'

export function createRuntimeAgentOwnerTestState(): Parameters<typeof getConnectionIdFromState>[0] {
  return { repos: [], worktreesByRepo: {}, folderWorkspaces: [], projectGroups: [] }
}

export function createRuntimeDetectedAgentsTestStore() {
  return createStore<AppState>()(
    withSessionSourceTestWrites(
      (...args) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this inventory fixture supplies only owner data and settings read by detection.
        ({
          ...createRuntimeDetectedAgentsSlice(...args),
          ...createRuntimeAgentOwnerTestState(),
          settings: getDefaultSettings('/test-home')
        }) as AppState
    )
  )
}

export function makeDetectedRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return {
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}
