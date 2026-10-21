// Ledger L104's reason, as a switch-off window shows it: a stored partition an older writer left
// restores differently once a full save of main's model rewrites it, so main patches only the
// records a change touches (record-patch-versus-full-save.test.ts).

import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { reconcileHydratedWorkspaceTabModels } from '../../app-shell/reconcile-hydrated-workspace-tab-models'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import { GIT_KEY } from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

/** The terminal tabs a window restoring `session` shows, in tab-bar order. */
function restoredTabs(session: WorkspaceSessionState): string[][] {
  const store = createTestStore()
  store.setState({
    repos: [
      { id: 'repo-1', path: '/Users/dev/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: GIT_KEY, repoId: 'repo-1', path: '/Users/dev/orca' })]
    }
  })
  store.getState().hydrateWorkspaceSession(structuredClone(session), {})
  store.getState().hydrateTabsSession(structuredClone(session), {})
  reconcileHydratedWorkspaceTabModels(session, store.getState().reconcileWorktreeTabModels)
  return (store.getState().groupsByWorktree[GIT_KEY] ?? []).map((group) => group.tabOrder)
}

function storedAndFullSave(name: string) {
  const profile = LEGACY_WORKSPACE_LAYOUT_PROFILES.find((candidate) => candidate.name === name)!
  const stored = profile.build()
  const full = saveWorkspaceLayout(
    loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
  )
  return { stored: restoredTabs(stored), full: restoredTabs(full) }
}

describe('a switch-off window restoring a legacy partition, as stored and after a full save', () => {
  it('loses a tab whose pane kept an old surface tombstone', () => {
    expect(
      storedAndFullSave('legacy surface tombstone on a pane still showing its terminal')
    ).toEqual({ stored: [['tab-a', 'tab-b']], full: [['tab-a']] })
  })

  it('gains a row the tab bar never listed', () => {
    expect(storedAndFullSave('row without a tab-bar entry or a terminal')).toEqual({
      stored: [['tab-a']],
      full: [['tab-a', 'tab-b']]
    })
  })
})
