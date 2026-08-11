import { describe, expect, it } from 'vitest'
import type { SshProviderEpoch } from '../../../../shared/ssh-types'
import type { DirectSshPaneRetryAttemptId } from './direct-ssh-terminal-recovery'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'
const SOURCE_TAB_ID = 'tab-source'
const TARGET_TAB_ID = 'tab-target'
const PRIMARY_PTY_ID = 'ssh:target-a@@pty-primary'
const SIBLING_PTY_ID = 'ssh:target-a@@pty-sibling'
const SURVIVOR_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const DETACHED_LEAF_ID = '22222222-2222-4222-8222-222222222222'

const authority = {
  targetId: 'target-a',
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 1
}

function createSplitDetachStore() {
  const store = createTestStore()
  seedStore(store, {
    repos: [
      {
        id: 'repo1',
        path: '/path',
        displayName: 'repo1',
        badgeColor: '#000',
        addedAt: 1,
        connectionId: authority.targetId,
        executionHostId: 'ssh:target-a'
      }
    ],
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo1',
          path: '/path/wt1',
          hostId: 'ssh:target-a'
        })
      ]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: SOURCE_TAB_ID, worktreeId: WORKTREE_ID, ptyId: PRIMARY_PTY_ID }),
        makeTab({ id: TARGET_TAB_ID, worktreeId: WORKTREE_ID, ptyId: null })
      ]
    },
    ptyIdsByTabId: {
      [SOURCE_TAB_ID]: [PRIMARY_PTY_ID, SIBLING_PTY_ID],
      [TARGET_TAB_ID]: []
    },
    directSshLivePtyBindingByTabId: {
      [SOURCE_TAB_ID]: {
        attemptId: 'split-detach' as DirectSshPaneRetryAttemptId,
        authority,
        tabGeneration: 0,
        ptyId: PRIMARY_PTY_ID
      }
    },
    directSshPaneRetryHistoryByTabId: {
      [SOURCE_TAB_ID]: { authority, attemptedAt: [1] }
    },
    sshConnectionStates: new Map([
      [
        authority.targetId,
        {
          targetId: authority.targetId,
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          providerEpoch: authority.providerEpoch,
          connectionGeneration: authority.connectionGeneration
        }
      ]
    ])
  })
  return store
}

describe('direct SSH split-pane detach ledger', () => {
  it.each([
    {
      label: 'primary',
      detachedPtyId: PRIMARY_PTY_ID,
      survivorPtyId: SIBLING_PTY_ID
    },
    {
      label: 'non-primary sibling',
      detachedPtyId: SIBLING_PTY_ID,
      survivorPtyId: PRIMARY_PTY_ID
    }
  ])(
    'preserves exact authority on both sides of a $label detach',
    ({ detachedPtyId, survivorPtyId }) => {
      const store = createSplitDetachStore()

      store.getState().syncPaneDetachPtyOwnership({
        detachedLeafId: DETACHED_LEAF_ID,
        detachedPtyId,
        sourceLayout: {
          root: { type: 'leaf', leafId: SURVIVOR_LEAF_ID },
          activeLeafId: SURVIVOR_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [SURVIVOR_LEAF_ID]: survivorPtyId }
        },
        sourceTabId: SOURCE_TAB_ID,
        targetTabId: TARGET_TAB_ID
      })

      expect(store.getState().directSshLivePtyBindingByTabId[SOURCE_TAB_ID]).toMatchObject({
        attemptId: 'split-detach',
        ptyId: survivorPtyId
      })
      expect(store.getState().directSshLivePtyBindingByTabId[TARGET_TAB_ID]).toMatchObject({
        attemptId: 'split-detach',
        ptyId: detachedPtyId
      })
      expect(store.getState().directSshPaneRetryHistoryByTabId[SOURCE_TAB_ID]).toEqual({
        authority,
        attemptedAt: [1]
      })
      expect(store.getState().directSshPaneRetryHistoryByTabId[TARGET_TAB_ID]).toEqual({
        authority,
        attemptedAt: [1]
      })
      expect(store.getState().invalidateStaleDirectSshTargetPtyBindings(authority)).toBe(0)
      expect(store.getState().retryDirectSshTargetPanes(authority, 2)).toBe(0)
    }
  )

  it('preserves source continuation when its sibling has not bound yet', () => {
    const store = createSplitDetachStore()
    const attemptId = 'split-detach' as DirectSshPaneRetryAttemptId
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((tab) =>
          tab.id === SOURCE_TAB_ID ? { ...tab, pendingActivationSpawn: true } : tab
        )
      },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        [SOURCE_TAB_ID]: [PRIMARY_PTY_ID]
      }
    }))

    store.getState().syncPaneDetachPtyOwnership({
      detachedLeafId: DETACHED_LEAF_ID,
      detachedPtyId: PRIMARY_PTY_ID,
      sourceLayout: {
        root: { type: 'leaf', leafId: SURVIVOR_LEAF_ID },
        activeLeafId: SURVIVOR_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      },
      sourceTabId: SOURCE_TAB_ID,
      targetTabId: TARGET_TAB_ID
    })

    expect(store.getState().directSshLivePtyBindingByTabId[SOURCE_TAB_ID]).toMatchObject({
      attemptId
    })
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0]).toMatchObject({
      ptyId: null,
      pendingActivationSpawn: true
    })

    store.getState().updateTabPtyId(SOURCE_TAB_ID, SIBLING_PTY_ID, undefined, attemptId)

    expect(store.getState().directSshLivePtyBindingByTabId[SOURCE_TAB_ID]).toMatchObject({
      attemptId,
      ptyId: SIBLING_PTY_ID
    })
    expect(store.getState().ptyIdsByTabId[SOURCE_TAB_ID]).toEqual([SIBLING_PTY_ID])
  })

  it('projects an empty continuation gap to both unbound detach sides', () => {
    const store = createSplitDetachStore()
    const attemptId = 'split-detach' as DirectSshPaneRetryAttemptId
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((tab) => ({
          ...tab,
          ptyId: null,
          pendingActivationSpawn: true
        }))
      },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        [SOURCE_TAB_ID]: []
      }
    }))

    store.getState().syncPaneDetachPtyOwnership({
      detachedLeafId: DETACHED_LEAF_ID,
      detachedPtyId: null,
      sourceLayout: {
        root: { type: 'leaf', leafId: SURVIVOR_LEAF_ID },
        activeLeafId: SURVIVOR_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      },
      sourceTabId: SOURCE_TAB_ID,
      targetTabId: TARGET_TAB_ID
    })

    expect(store.getState().directSshLivePtyBindingByTabId[SOURCE_TAB_ID]).toMatchObject({
      attemptId
    })
    expect(store.getState().directSshLivePtyBindingByTabId[TARGET_TAB_ID]).toMatchObject({
      attemptId
    })

    store.getState().updateTabPtyId(SOURCE_TAB_ID, SIBLING_PTY_ID, undefined, attemptId)
    store.getState().updateTabPtyId(TARGET_TAB_ID, PRIMARY_PTY_ID, undefined, attemptId)

    expect(store.getState().ptyIdsByTabId[SOURCE_TAB_ID]).toEqual([SIBLING_PTY_ID])
    expect(store.getState().ptyIdsByTabId[TARGET_TAB_ID]).toEqual([PRIMARY_PTY_ID])
  })

  it('preserves a pending-only lease when both detach sides are still unbound', () => {
    const store = createSplitDetachStore()
    const attemptId = 'split-pending-only' as DirectSshPaneRetryAttemptId
    store.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((tab) => ({
          ...tab,
          ptyId: null,
          pendingActivationSpawn: true
        }))
      },
      ptyIdsByTabId: {
        ...state.ptyIdsByTabId,
        [SOURCE_TAB_ID]: []
      },
      directSshLivePtyBindingByTabId: {},
      directSshPaneRetryByTabId: {
        [SOURCE_TAB_ID]: {
          attemptId,
          authority,
          tabGeneration: 0,
          startedAt: 1
        }
      }
    }))

    store.getState().syncPaneDetachPtyOwnership({
      detachedLeafId: DETACHED_LEAF_ID,
      detachedPtyId: null,
      sourceLayout: {
        root: { type: 'leaf', leafId: SURVIVOR_LEAF_ID },
        activeLeafId: SURVIVOR_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      },
      sourceTabId: SOURCE_TAB_ID,
      targetTabId: TARGET_TAB_ID
    })

    expect(store.getState().directSshPaneRetryByTabId).toMatchObject({
      [SOURCE_TAB_ID]: { attemptId, authority, tabGeneration: 0 },
      [TARGET_TAB_ID]: { attemptId, authority, tabGeneration: 0 }
    })

    store.getState().updateTabPtyId(SOURCE_TAB_ID, SIBLING_PTY_ID, undefined, attemptId)
    store.getState().updateTabPtyId(TARGET_TAB_ID, PRIMARY_PTY_ID, undefined, attemptId)

    expect(store.getState().ptyIdsByTabId[SOURCE_TAB_ID]).toEqual([SIBLING_PTY_ID])
    expect(store.getState().ptyIdsByTabId[TARGET_TAB_ID]).toEqual([PRIMARY_PTY_ID])
  })
})
