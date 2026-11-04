import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab, seedStore } from './store-test-helpers'

{
  describe('terminal PTY identity replacement', () => {
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
          tabPtyId:
            state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.ptyId ?? null,
          panePtyId: state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null
        })
      })

      store.getState().updateTabPtyId(tabId, replacementPtyId, stalePtyId)
      unsubscribe()

      expect(observed).toEqual([{ tabPtyId: replacementPtyId, panePtyId: replacementPtyId }])
    })
  })
}
