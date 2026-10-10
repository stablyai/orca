import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import '../../../../../shared/constants'
import { buildMobileSessionTabSnapshots } from '../../../runtime/sync-runtime-graph/mobile-session-snapshots'
import { closeMobileSessionTabInStore } from '../../../runtime/web-session-tabs-sync/closing/mobile-session-tab-close'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeOpenFile } from '../editor/types/open-file.test-fixture'
import { makeTabGroup, makeUnifiedTab } from './tab-group.test-fixture'
import { seedThreePaneLayout } from './three-pane-layout.test-fixture'
import { makeBrowserTab } from '../browser/browser-tab.test-fixture'

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

  describe('createUnifiedTab', () => {
    it('opens the second pane beside the first, in a new right-hand group', () => {
      const first = store.getState().createUnifiedTab(WT, 'terminal')
      const second = store.getState().createUnifiedTab(WT, 'editor', {
        id: '/tmp/feature/src/main.ts',
        label: 'main.ts'
      })

      const state = store.getState()
      expect(second.groupId).not.toBe(first.groupId)
      expect(state.groupsByWorktree[WT].map((group) => group.id)).toEqual([
        first.groupId,
        second.groupId
      ])
      expect(state.layoutByWorktree[WT]).toEqual({
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: first.groupId },
        second: { type: 'leaf', groupId: second.groupId }
      })
      expect(state.activeGroupIdByWorktree[WT]).toBe(second.groupId)
      expect(state.groupsByWorktree[WT][1]).toMatchObject({
        activeTabId: second.id,
        tabOrder: [second.id]
      })
    })

    it('never opens a third pane: the third tab opens opposite the focused pane', () => {
      const first = store.getState().createUnifiedTab(WT, 'terminal')
      const second = store.getState().createUnifiedTab(WT, 'terminal')
      const third = store.getState().createUnifiedTab(WT, 'browser')

      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(2)
      // Why: both sides show a terminal, so it opens opposite the focused (second) pane.
      expect(third.groupId).toBe(first.groupId)
      expect(state.layoutByWorktree[WT]).toMatchObject({
        type: 'split',
        first: { type: 'leaf', groupId: first.groupId },
        second: { type: 'leaf', groupId: second.groupId }
      })
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([first.id, third.id])
    })

    it('re-arms once the area collapses back to one pane', () => {
      const first = store.getState().createUnifiedTab(WT, 'terminal')
      const second = store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().closeUnifiedTab(second.id)
      expect(store.getState().layoutByWorktree[WT]).toEqual({
        type: 'leaf',
        groupId: first.groupId
      })

      const third = store.getState().createUnifiedTab(WT, 'terminal')
      expect(third.groupId).not.toBe(first.groupId)
      expect(store.getState().groupsByWorktree[WT]).toHaveLength(2)
    })

    it('opens beside without focusing when activate is false', () => {
      const first = store.getState().createUnifiedTab(WT, 'terminal')
      const second = store.getState().createUnifiedTab(WT, 'browser', { activate: false })

      const state = store.getState()
      expect(second.groupId).not.toBe(first.groupId)
      expect(state.activeGroupIdByWorktree[WT]).toBe(first.groupId)
      expect(state.groupsByWorktree[WT][0]).toMatchObject({
        activeTabId: first.id,
        recentTabIds: [first.id]
      })
      // Why: the new group still needs its own active tab or the right pane renders nothing.
      expect(state.groupsByWorktree[WT][1]).toMatchObject({ activeTabId: second.id })
    })

    it('carries the caller metadata through the split', () => {
      store.getState().createUnifiedTab(WT, 'terminal')
      const second = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'tab-id-from-caller',
        entityId: '/tmp/feature/src/main.ts',
        label: 'main.ts'
      })

      expect(second.id).toBe('tab-id-from-caller')
      expect(second.entityId).toBe('/tmp/feature/src/main.ts')
      expect(second.label).toBe('main.ts')
    })

    it('skips the rule when the caller has already decided placement', () => {
      const first = store.getState().createUnifiedTab(WT, 'terminal')
      const second = store.getState().createUnifiedTab(WT, 'browser', { placementFixed: true })

      expect(second.groupId).toBe(first.groupId)
      expect(store.getState().layoutByWorktree[WT]).toEqual({
        type: 'leaf',
        groupId: first.groupId
      })
    })

    it('does not record a pane-split interaction for an automatic split', () => {
      // Why: the user did not split anything; feature discovery must stay honest.
      const recordSpy = vi.spyOn(store.getState(), 'recordFeatureInteraction')
      store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'editor', { id: '/a.ts' })

      const recorded = recordSpy.mock.calls.map(([id]) => id)
      expect(recorded).not.toContain('tab-splits')
      expect(recorded).not.toContain('terminal-panes')
      expect(recorded).toContain('terminal-tabs')
    })

    it('reuses the existing group once the area is split', () => {
      seedThreePaneLayout(store, WT)
      store.getState().createUnifiedTab(WT, 'terminal')
      store.getState().createUnifiedTab(WT, 'editor', { id: 'f.ts', label: 'f.ts' })

      expect(store.getState().groupsByWorktree[WT]).toHaveLength(3)
    })
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
