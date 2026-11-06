import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveAutoAckTabTargets } from '@/hooks/agent-auto-ack-targets'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeOpenFile } from './store-test-helpers'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

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

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('TabsSlice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  describe('activateTab', () => {
    it('promotes a preview tab to permanent on activation', async () => {
      store.setState({ openFiles: [makeOpenFile({ id: 'f.ts', worktreeId: WT, isPreview: true })] })
      const preview = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'f.ts',
        label: 'f.ts',
        isPreview: true
      })
      const main = await drawTabsFromMain(store)
      try {
        expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(true)

        store.getState().activateTab(preview.id)
        // A layout-owner build: main promotes it, and only its frame ends the preview.
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(true)
          expect(layoutApplyTestTransport.sentOfType('promotePreviewTab')).toEqual([
            { type: 'promotePreviewTab', workspace: WT, tabId: preview.id }
          ])
        }
        await main.settle()

        expect(store.getState().unifiedTabsByWorktree[WT][0].isPreview).toBe(
          ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : false
        )
      } finally {
        main.close()
      }
    })
  })

  // Already-active group clicks skip activateTab; focusGroup must still expose its tab to the attention scan.
  describe('focusGroup', () => {
    it('does not broadcast active-surface writes when the focused group is already current', () => {
      const editorFileId = '/tmp/feature/src/main.ts'
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'editor-tab-1',
        entityId: editorFileId,
        label: 'main.ts'
      })
      const groupId = store.getState().groupsByWorktree[WT][0].id
      store.setState({
        activeWorktreeId: WT,
        openFiles: [makeOpenFile({ id: editorFileId, worktreeId: WT })],
        activeGroupIdByWorktree: { [WT]: groupId },
        activeFileId: editorFileId,
        activeFileIdByWorktree: { [WT]: editorFileId },
        activeBrowserTabId: null,
        activeBrowserTabIdByWorktree: { [WT]: null },
        activeTabId: null,
        activeTabIdByWorktree: { [WT]: null },
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' },
        groupsByWorktree: {
          [WT]: [
            {
              ...store.getState().groupsByWorktree[WT][0],
              activeTabId: tab.id
            }
          ]
        }
      })
      const before = store.getState()
      const listener = vi.fn()
      const unsubscribe = store.subscribe(listener)

      store.getState().focusGroup(WT, groupId)
      unsubscribe()

      expect(listener).not.toHaveBeenCalled()
      expect(store.getState().activeGroupIdByWorktree).toBe(before.activeGroupIdByWorktree)
      expect(store.getState().activeFileIdByWorktree).toBe(before.activeFileIdByWorktree)
      expect(store.getState().activeTabTypeByWorktree).toBe(before.activeTabTypeByWorktree)
    })

    // Why: focusGroup fires on every pointerdown in the group chrome; it moves what is on screen and the scan reads it.
    it("puts the focused group's active tab on screen", () => {
      const tabA = store.getState().createUnifiedTab(WT, 'terminal')
      const groupAId = store.getState().groupsByWorktree[WT][0].id
      const groupBId = store.getState().createEmptySplitGroup(WT, groupAId, 'right')
      if (!groupBId) {
        throw new Error('createEmptySplitGroup returned null')
      }
      const tabB = store.getState().createUnifiedTab(WT, 'terminal', { targetGroupId: groupBId })
      store.getState().focusGroup(WT, groupBId)

      store.setState({
        unreadTerminalTabs: { [tabA.entityId]: true as const },
        activeWorktreeId: WT,
        activeView: 'terminal'
      })

      // Clicking Group A's chrome re-focuses it without calling activateTab (active tab unchanged).
      store.getState().focusGroup(WT, groupAId)

      expect(resolveAutoAckTabTargets(store.getState())[0]).toEqual({
        tabId: tabA.entityId,
        worktreeId: WT,
        surfaceKind: 'terminal'
      })
      expect(resolveAutoAckTabTargets(store.getState())).toContainEqual({
        tabId: tabB.entityId,
        worktreeId: WT,
        surfaceKind: 'terminal'
      })
    })
  })
})
