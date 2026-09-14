import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab, seedStore } from './store-test-helpers'

describe('terminal PTY identity replacement', () => {
  it('keeps repeated remote handle rotations bounded to the live identity', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const firstPtyId = 'remote:env-1@@terminal-1'
    const secondPtyId = 'remote:env-1@@terminal-2'
    const thirdPtyId = 'remote:env-1@@terminal-3'
    seedStore(store, {
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: firstPtyId })]
      },
      ptyIdsByTabId: { 'tab-1': [firstPtyId] },
      suppressedPtyExitIds: { [firstPtyId]: true }
    })

    store.getState().updateTabPtyId('tab-1', secondPtyId, firstPtyId)
    store.getState().updateTabPtyId('tab-1', thirdPtyId, secondPtyId)

    const state = store.getState()
    expect(state.ptyIdsByTabId['tab-1']).toEqual([thirdPtyId])
    expect(state.tabsByWorktree[worktreeId][0]?.ptyId).toBe(thirdPtyId)
    expect(state.lastKnownRelayPtyIdByTabId['tab-1']).toBe(thirdPtyId)
    expect(state.suppressedPtyExitIds).toEqual({ [thirdPtyId]: true })
  })

  it('migrates stale PTY state when the host snapshot published the replacement first', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const stalePtyId = 'remote:env-1@@terminal-stale'
    const replacementPtyId = 'remote:env-1@@terminal-replacement'
    seedStore(store, {
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: replacementPtyId })]
      },
      ptyIdsByTabId: { 'tab-1': [replacementPtyId] },
      pendingCodexPaneRestartIds: { [stalePtyId]: true }
    })

    store.getState().updateTabPtyId('tab-1', replacementPtyId, stalePtyId)

    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([replacementPtyId])
    expect(store.getState().pendingCodexPaneRestartIds).toEqual({ [replacementPtyId]: true })
  })

  it('publishes pane and tab replacement identities in one store commit', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const stalePtyId = 'remote:env-1@@terminal-stale'
    const replacementPtyId = 'remote:env-1@@terminal-replacement'
    const tabId = 'tab-1'
    const leafId = 'pane:1'
    seedStore(store, {
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: tabId, worktreeId, ptyId: stalePtyId })]
      },
      ptyIdsByTabId: { [tabId]: [stalePtyId] },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: stalePtyId }
        }
      }
    })
    const observed: { tabPtyId: string | null; panePtyId: string | null }[] = []
    const unsubscribe = store.subscribe((state) => {
      observed.push({
        tabPtyId: state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.ptyId ?? null,
        panePtyId: state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null
      })
    })

    store.getState().updateTabPtyId(tabId, replacementPtyId, stalePtyId)
    unsubscribe()

    expect(observed).toEqual([{ tabPtyId: replacementPtyId, panePtyId: replacementPtyId }])
  })
})
