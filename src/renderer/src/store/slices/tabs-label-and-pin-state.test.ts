import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeOpenFile } from './store-test-helpers'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { withLayoutOwnerTabProps } from '@/components/tab-bar/tab-bar-layout-owner-props'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

{
  // Mock sonner (imported by repos.ts)

  // Mock agent-status (imported by terminal-helpers)

  createTabsSliceMockApi()
  const mockWindow = globalThis.window

  const WT = 'repo1::/tmp/feature'

  describe('TabsSlice', () => {
    beforeEach(() => {
      globalThis.window = mockWindow
    })

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
      it('pins a tab and promotes preview to permanent', async () => {
        store.setState({
          openFiles: [makeOpenFile({ id: 'f.ts', worktreeId: WT, isPreview: true })]
        })
        const tab = store.getState().createUnifiedTab(WT, 'editor', {
          id: 'f.ts',
          label: 'f.ts',
          isPreview: true
        })
        const main = await drawTabsFromMain(store)
        try {
          const pin = (): void => store.getState().pinTab(tab.id)
          // A layout-owner build pins through main first, as the tab bar does; then main promotes.
          if (ORCA_LAYOUT_OWNER_IS_MAIN) {
            withLayoutOwnerTabProps(
              {
                togglePinned: pin,
                makePreviewFilePermanent: (fileId, tabId) =>
                  store.getState().makePreviewFilePermanent(fileId, tabId)
              },
              () => WT
            ).togglePinned({
              unifiedTabId: tab.id,
              isPinned: false,
              type: 'editor',
              data: { id: 'f.ts' }
            })
          } else {
            pin()
          }
          await main.settle()

          const updated = store.getState().unifiedTabsByWorktree[WT][0]
          expect(updated.isPinned).toBe(true)
          expect(updated.isPreview).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : false)
          if (ORCA_LAYOUT_OWNER_IS_MAIN) {
            expect(layoutApplyTestTransport.sentOfType('promotePreviewTab')).toEqual([
              { type: 'promotePreviewTab', workspace: WT, tabId: tab.id }
            ])
          }
        } finally {
          main.close()
        }
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

      it('syncs isPinned to the TerminalTab in tabsByWorktree (reconcile echo guard)', async () => {
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

        // A layout-owner build draws the color from main's frame.
        const main = await drawTabsFromMain(store)
        try {
          const interaction = vi.fn()
          store.setState({ recordFeatureInteraction: interaction })
          store.getState().pinTab(tab.id, { recordInteraction: false })
          expect(store.getState().tabsByWorktree[WT][0].isPinned).toBe(true)
          store.getState().unpinTab(tab.id, { recordInteraction: false })
          expect(store.getState().tabsByWorktree[WT][0].isPinned).toBe(false)
          store.getState().setTabColor(tab.entityId, '#ff0000', { recordInteraction: false })
          await main.settle()
          expect(store.getState().tabsByWorktree[WT][0].color).toBe('#ff0000')
          expect(interaction).not.toHaveBeenCalled()
          store.getState().pinTab(tab.id)
          store.getState().unpinTab(tab.id)
          store.getState().setTabColor(tab.entityId, null)
          await main.settle()
          expect(interaction).toHaveBeenCalledTimes(3)
        } finally {
          main.close()
        }
      })
    })
  })
}

{
  createTabsSliceMockApi()
  const mockWindow = globalThis.window

  const WT = 'repo1::/tmp/feature'

  describe('createEmptySplitGroup', () => {
    beforeEach(() => {
      globalThis.window = mockWindow
    })

    let store: ReturnType<typeof createTestStore>

    beforeEach(() => {
      store = createTestStore()
    })

    it('activates the new group by default so terminal splits land in the empty pane', () => {
      const tab = store.getState().createUnifiedTab(WT, 'terminal')
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')

      expect(targetGroupId).toBeTruthy()
      expect(store.getState().activeGroupIdByWorktree[WT]).toBe(targetGroupId)
      expect(
        store.getState().groupsByWorktree[WT].find((group) => group.id === sourceGroupId)
      ).toEqual(expect.objectContaining({ tabOrder: [tab.id] }))
    })

    it('keeps the source group focused when activate is false', () => {
      store.getState().createUnifiedTab(WT, 'editor', { id: 'file-a.ts', label: 'file-a.ts' })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right', {
        activate: false
      })

      expect(targetGroupId).toBeTruthy()
      expect(store.getState().activeGroupIdByWorktree[WT]).toBe(sourceGroupId)
      expect(store.getState().groupsByWorktree[WT].map((group) => group.id)).toEqual([
        sourceGroupId,
        targetGroupId
      ])
    })
  })
}
