import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import '../../../../../shared/constants'
import { buildMobileSessionTabSnapshots } from '../../../runtime/sync-runtime-graph/mobile-session-snapshots'
import { closeMobileSessionTabInStore } from '../../../runtime/web-session-tabs-sync/closing/mobile-session-tab-close'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeOpenFile } from '../editor/types/open-file.test-fixture'
import { makeTabGroup, makeUnifiedTab } from './tab-group.test-fixture'

import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'

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

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
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

  describe('closeUnifiedTab', () => {
    it('removes a mobile-closed markdown tab from open files so it is not republished', async () => {
      const groupId = 'editor-group'
      const file = makeOpenFile({
        id: '/tmp/feature/README.md',
        filePath: '/tmp/feature/README.md',
        relativePath: 'README.md',
        language: 'markdown',
        worktreeId: WT
      })
      const tab = makeUnifiedTab({
        id: 'readme-unified',
        entityId: file.id,
        contentType: 'editor',
        label: 'README.md',
        worktreeId: WT,
        groupId
      })
      store.setState({
        openFiles: [file],
        unifiedTabsByWorktree: { [WT]: [tab] },
        groupsByWorktree: {
          [WT]: [
            makeTabGroup({
              id: groupId,
              worktreeId: WT,
              activeTabId: tab.id,
              tabOrder: [tab.id],
              recentTabIds: [tab.id]
            })
          ]
        },
        activeGroupIdByWorktree: { [WT]: groupId },
        activeFileId: file.id,
        activeFileIdByWorktree: { [WT]: file.id },
        activeWorktreeId: WT,
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' }
      })

      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs).toMatchObject([
        { id: tab.id, type: 'markdown', filePath: file.filePath }
      ])

      const main = await drawTabsFromMain(store)
      expect(closeMobileSessionTabInStore(store.getState(), WT, tab.id)).toBe(true)
      // A layout-owner build closes the tab in main; the file goes after its frame drops the tab.
      await main.settle()
      main.close()

      expect(store.getState().openFiles).toEqual([])
      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs ?? []).toEqual([])
    })
  })
})
