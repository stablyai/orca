import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import '../../../../shared/constants'
import { buildMobileSessionTabSnapshots } from '../../runtime/sync-runtime-graph/mobile-session-snapshots'
import { closeMobileSessionTabInStore } from '../../runtime/mobile-session-tab-close'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import {
  createTestStore,
  makeLayout,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab
} from './store-test-helpers'
import { makeBrowserTab } from './store-session-test-harness'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'

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

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

/** The terminal row, browser record and open file main loads these tabs' entries with. */
function seedContentRecords(
  target: ReturnType<typeof createTestStore>,
  ids: { terminalId: string; browserId?: string; fileId: string }
): void {
  target.setState({
    tabsByWorktree: { [WT]: [makeTab({ id: ids.terminalId, worktreeId: WT })] },
    terminalLayoutsByTabId: { [ids.terminalId]: makeLayout() },
    browserTabsByWorktree: ids.browserId
      ? { [WT]: [makeBrowserTab({ id: ids.browserId, worktreeId: WT, url: 'about:blank' })] }
      : {},
    openFiles: [makeOpenFile({ id: ids.fileId, worktreeId: WT })]
  })
}

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

    it('closes a mobile fallback file-id tab after the unified wrapper is already gone', () => {
      const file = makeOpenFile({
        id: '/tmp/feature/src/app.ts',
        filePath: '/tmp/feature/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
        worktreeId: WT
      })
      store.setState({
        openFiles: [file],
        unifiedTabsByWorktree: { [WT]: [] },
        groupsByWorktree: { [WT]: [] },
        activeFileId: file.id,
        activeFileIdByWorktree: { [WT]: file.id },
        activeWorktreeId: WT,
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' }
      })

      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs).toMatchObject([
        { id: file.id, type: 'file', filePath: file.filePath }
      ])

      expect(closeMobileSessionTabInStore(store.getState(), WT, file.id)).toBe(true)

      expect(store.getState().openFiles).toEqual([])
      expect(buildMobileSessionTabSnapshots(store.getState())[0]?.tabs ?? []).toEqual([])
    })

    it('activates the previously-active tab across content types', async () => {
      seedContentRecords(store, { terminalId: 'term-1', browserId: 'browser-1', fileId: 'f.ts' })
      const t1 = store.getState().createUnifiedTab(WT, 'terminal', { id: 'term-1' })
      const t2 = store.getState().createUnifiedTab(WT, 'browser', { id: 'browser-1' })
      const t3 = store.getState().createUnifiedTab(WT, 'editor', { id: 'f.ts' })
      const main = await drawTabsFromMain(store)

      // Visit order ...→t3→t1→t3; closing t3 should jump to t1, not browser neighbor t2.
      store.getState().activateTab(t1.id)
      store.getState().activateTab(t3.id)
      store.getState().closeUnifiedTab(t3.id)
      // A layout-owner build picks the previous tab once main's frame dropped the closed one.
      await main.settle()
      main.close()

      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBe(t1.id)
      expect(
        store
          .getState()
          .unifiedTabsByWorktree[WT].map((t) => t.id)
          .sort()
      ).toEqual([t1.id, t2.id].sort())
    })
  })
})
