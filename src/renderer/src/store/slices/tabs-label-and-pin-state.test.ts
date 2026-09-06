import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from './store-test-helpers'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('TabsSlice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  // ─── setTabLabel / setTabCustomLabel / setUnifiedTabColor ─────────

  describe('tab property setters', () => {
    it('setTabLabel updates the label', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabLabel(tab.id, 'zsh')
      expect(store.getState().unifiedTabsByWorktree[WT][0].label).toBe('zsh')
    })

    it('setTabLabel preserves tab map references when the label is unchanged', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabLabel(tab.id, 'zsh')
      const before = store.getState().unifiedTabsByWorktree

      store.getState().setTabLabel(tab.id, 'zsh')

      expect(store.getState().unifiedTabsByWorktree).toBe(before)
    })

    it('setTabCustomLabel updates customLabel', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabCustomLabel(tab.id, 'my-term')
      expect(store.getState().unifiedTabsByWorktree[WT][0].customLabel).toBe('my-term')
    })

    it('setTabCustomLabel clears customLabel with null', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setTabCustomLabel(tab.id, 'my-term')
      store.getState().setTabCustomLabel(tab.id, null)
      expect(store.getState().unifiedTabsByWorktree[WT][0].customLabel).toBeNull()
    })

    it('setUnifiedTabColor updates color', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().setUnifiedTabColor(tab.id, '#ff0000')
      expect(store.getState().unifiedTabsByWorktree[WT][0].color).toBe('#ff0000')
    })
  })

  // ─── pinTab / unpinTab ────────────────────────────────────────────

  describe('pinTab / unpinTab', () => {
    it('pins a tab and promotes preview to permanent', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'f.ts',
        label: 'f.ts',
        isPreview: true
      })

      store.getState().pinTab(tab.id)

      const updated = store.getState().unifiedTabsByWorktree[WT][0]
      expect(updated.isPinned).toBe(true)
      expect(updated.isPreview).toBe(false)
    })

    it('moves pinned tabs before unpinned siblings', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')

      store.getState().pinTab(t3.id)
      store.getState().pinTab(t2.id)

      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual([t3.id, t2.id, t1.id])
      expect(store.getState().unifiedTabsByWorktree[WT].map((tab) => tab.sortOrder)).toEqual([
        2, 1, 0
      ])
    })

    it('unpins a tab', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().pinTab(tab.id)
      store.getState().unpinTab(tab.id)
      expect(store.getState().unifiedTabsByWorktree[WT][0].isPinned).toBe(false)
    })

    it('keeps remaining pinned tabs before a tab that was unpinned', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().pinTab(t2.id)
      store.getState().pinTab(t3.id)

      store.getState().unpinTab(t2.id)

      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual([t3.id, t2.id, t1.id])
    })

    it('syncs isPinned to the TerminalTab in tabsByWorktree (reconcile echo guard)', () => {
      // Why: reconcile derives pin from tabsByWorktree[*].isPinned; without syncing, a host snapshot re-computes isPinned:false and un-pins during the echo window.
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      store.setState((state) => ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [WT]: [
            {
              id: tab.id,
              ptyId: null,
              worktreeId: WT,
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      }))

      store.getState().pinTab(tab.id)
      expect(store.getState().tabsByWorktree[WT][0].isPinned).toBe(true)

      store.getState().unpinTab(tab.id)
      expect(store.getState().tabsByWorktree[WT][0].isPinned).toBe(false)
    })
  })
})
