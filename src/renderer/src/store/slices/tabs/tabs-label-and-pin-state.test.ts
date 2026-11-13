import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeOpenFile } from '../editor/types/open-file.test-fixture'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { withLayoutOwnerTabProps } from '@/components/tab-bar/tab-bar-layout-owner-props'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

{
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
    })
  })
}
