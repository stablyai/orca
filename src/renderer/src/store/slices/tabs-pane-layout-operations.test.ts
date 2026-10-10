import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultUIState } from '../../../../shared/constants'
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

  // ─── reorderUnifiedTabs ───────────────────────────────────────────

  describe('reorderUnifiedTabs', () => {
    it('updates tabOrder on the group and sortOrder on tabs', () => {
      const t1 = store.getState().createUnifiedTab(WT, 'terminal')
      const t2 = store.getState().createUnifiedTab(WT, 'terminal')
      const t3 = store.getState().createUnifiedTab(WT, 'terminal')

      const groupId = store.getState().groupsByWorktree[WT][0].id
      store.getState().reorderUnifiedTabs(groupId, [t3.id, t1.id, t2.id])

      const group = store.getState().groupsByWorktree[WT][0]
      expect(group.tabOrder).toEqual([t3.id, t1.id, t2.id])

      const tabs = store.getState().unifiedTabsByWorktree[WT]
      const sorted = [...tabs].sort((a, b) => a.sortOrder - b.sortOrder)
      expect(sorted.map((t) => t.id)).toEqual([t3.id, t1.id, t2.id])
    })
  })

  describe('setTabGroupSplitRatio', () => {
    it('updates the persisted ratio for the targeted split node', () => {
      store.setState({
        layoutByWorktree: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', groupId: 'g-1' },
            second: {
              type: 'split',
              direction: 'vertical',
              ratio: 0.5,
              first: { type: 'leaf', groupId: 'g-2' },
              second: { type: 'leaf', groupId: 'g-3' }
            }
          }
        }
      })

      store.getState().setTabGroupSplitRatio(WT, 'second', 0.7)

      const layout = store.getState().layoutByWorktree[WT]
      expect(layout.type).toBe('split')
      if (layout.type !== 'split' || layout.second.type !== 'split') {
        throw new Error('expected nested split layout')
      }
      expect(layout.ratio).toBe(0.5)
      expect(layout.second.ratio).toBe(0.7)
    })

    it('keeps state identity when the ratio is unchanged', () => {
      store.setState({
        layoutByWorktree: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', groupId: 'g-1' },
            second: { type: 'leaf', groupId: 'g-2' }
          }
        }
      })
      const beforeState = store.getState()
      const beforeLayout = beforeState.layoutByWorktree
      const subscriber = vi.fn()
      const unsubscribe = store.subscribe(subscriber)

      // Why: an unchanged commit must not mint fresh root state — every store
      // subscriber wakes on the new reference (STA-3328).
      store.getState().setTabGroupSplitRatio(WT, '', 0.5)
      expect(store.getState()).toBe(beforeState)
      expect(store.getState().layoutByWorktree).toBe(beforeLayout)
      expect(subscriber).not.toHaveBeenCalled()

      store.getState().setTabGroupSplitRatio(WT, '', 0.5004)
      expect(store.getState().layoutByWorktree).not.toBe(beforeLayout)
      expect(subscriber).toHaveBeenCalledOnce()
      expect((store.getState().layoutByWorktree[WT] as { ratio: number }).ratio).toBe(0.5004)
      unsubscribe()
    })
  })

  describe('move/copy/merge group operations', () => {
    it('moves a unified tab into another group', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(targetGroupId).toBeTruthy()

      store.getState().moveUnifiedTabToGroup(tab.id, targetGroupId!)

      const state = store.getState()
      const moved = state.unifiedTabsByWorktree[WT].find((item) => item.id === tab.id)
      expect(moved?.groupId).toBe(targetGroupId)
      expect(state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)).toBeUndefined()
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === targetGroupId)?.tabOrder
      ).toEqual([tab.id])
    })

    it('copies a unified tab into another group', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        executionHostId: 'runtime:host-b',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(targetGroupId).toBeTruthy()

      const copied = store.getState().copyUnifiedTabToGroup(tab.id, targetGroupId!)

      expect(copied).not.toBeNull()
      const state = store.getState()
      expect(state.unifiedTabsByWorktree[WT]).toHaveLength(2)
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)?.tabOrder
      ).toEqual([tab.id])
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === targetGroupId)?.tabOrder
      ).toEqual([copied!.id])
      expect(copied?.entityId).toBe(tab.entityId)
      expect(copied?.executionHostId).toBe('runtime:host-b')
    })

    it('merges a group into its sibling', () => {
      const setMock = vi.mocked(window.api.ui.set)
      const t1 = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(targetGroupId).toBeTruthy()
      store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-b.ts',
        label: 'file-b.ts',
        targetGroupId: targetGroupId!
      })
      store.getState().hydratePersistedUI(getDefaultUIState())
      setMock.mockClear()

      const mergedInto = store.getState().mergeGroupIntoSibling(WT, targetGroupId!)

      expect(mergedInto).toBe(sourceGroupId)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([t1.id, 'file-b.ts'])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: sourceGroupId })
      expect(setMock).toHaveBeenCalledTimes(1)
      expect(setMock).toHaveBeenCalledWith({
        featureInteractions: {
          'terminal-panes': expect.objectContaining({ interactionCount: 1 })
        }
      })
    })

    it('drops a unified tab into another group and collapses an emptied source group', () => {
      const tab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      const targetGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')
      expect(targetGroupId).toBeTruthy()

      const moved = store.getState().dropUnifiedTab(tab.id, { groupId: targetGroupId! })

      expect(moved).toBe(true)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT][0].id).toBe(targetGroupId)
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([tab.id])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: targetGroupId })
      expect(state.activeGroupIdByWorktree[WT]).toBe(targetGroupId)
    })

    it('drops a unified tab onto a pane edge to create a sibling split', () => {
      const first = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const second = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-b.ts',
        label: 'file-b.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

      const moved = store.getState().dropUnifiedTab(second.id, {
        groupId: sourceGroupId,
        splitDirection: 'right'
      })

      expect(moved).toBe(true)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(2)

      const originGroup = state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)
      expect(originGroup?.tabOrder).toEqual([first.id])

      const movedTab = state.unifiedTabsByWorktree[WT].find((tab) => tab.id === second.id)
      const newGroupId = movedTab?.groupId
      expect(newGroupId).toBeTruthy()
      expect(newGroupId).not.toBe(sourceGroupId)
      expect(state.groupsByWorktree[WT].find((group) => group.id === newGroupId)?.tabOrder).toEqual(
        [second.id]
      )

      const layout = state.layoutByWorktree[WT]
      expect(layout.type).toBe('split')
      if (layout.type !== 'split') {
        throw new Error('expected split layout after edge drop')
      }
      expect(layout.direction).toBe('horizontal')
      expect(layout.first).toEqual({ type: 'leaf', groupId: sourceGroupId })
      expect(layout.second).toEqual({ type: 'leaf', groupId: newGroupId })
    })

    it('creates a unified tab directly in a sibling split without publishing a source-group midpoint', () => {
      const terminal = store.getState().createUnifiedTab(WT, 'terminal', {
        id: 'terminal-1',
        label: 'Terminal 1'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      store.setState({ activeWorktreeId: WT })
      const publishedSimulatorGroupIds: (string | null)[] = []
      const unsubscribe = store.subscribe((state) => {
        publishedSimulatorGroupIds.push(
          state.unifiedTabsByWorktree[WT]?.find((tab) => tab.contentType === 'simulator')
            ?.groupId ?? null
        )
      })

      const simulator = store.getState().createUnifiedTabInSplit(
        WT,
        'simulator',
        {
          sourceGroupId,
          splitDirection: 'right'
        },
        {
          id: 'simulator-1',
          label: 'Mobile Emulator'
        }
      )
      unsubscribe()

      expect(simulator).not.toBeNull()
      expect(publishedSimulatorGroupIds).not.toContain(sourceGroupId)
      const state = store.getState()
      const simulatorGroupId = simulator!.groupId
      expect(state.activeWorktreeId).toBe(WT)
      expect(state.activeTabType).toBe('simulator')
      expect(state.activeGroupIdByWorktree[WT]).toBe(simulatorGroupId)
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === sourceGroupId)?.tabOrder
      ).toEqual([terminal.id])
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === simulatorGroupId)?.tabOrder
      ).toEqual([simulator!.id])
      const layout = state.layoutByWorktree[WT]
      expect(layout.type).toBe('split')
      if (layout.type !== 'split') {
        throw new Error('expected split layout after split tab creation')
      }
      expect(layout.direction).toBe('horizontal')
      expect(layout.first).toEqual({ type: 'leaf', groupId: sourceGroupId })
      expect(layout.second).toEqual({ type: 'leaf', groupId: simulatorGroupId })
    })

    it('creates a split tab without stealing focus when activation is disabled', () => {
      store.getState().createUnifiedTab(WT, 'terminal', {
        id: 'terminal-1',
        label: 'Terminal 1'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
      store.setState({ activeWorktreeId: WT })

      const simulator = store.getState().createUnifiedTabInSplit(
        WT,
        'simulator',
        {
          sourceGroupId,
          splitDirection: 'right'
        },
        {
          id: 'simulator-1',
          label: 'Mobile Emulator',
          activate: false
        }
      )

      expect(simulator).not.toBeNull()
      const state = store.getState()
      expect(state.activeGroupIdByWorktree[WT]).toBe(sourceGroupId)
      expect(state.activeTabType).toBe('terminal')
      expect(
        state.groupsByWorktree[WT].find((group) => group.id === simulator!.groupId)?.recentTabIds
      ).toEqual([])
    })

    it('treats splitting the only tab onto its own pane body as a no-op', () => {
      const onlyTab = store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const sourceGroupId = store.getState().groupsByWorktree[WT][0].id

      const moved = store.getState().dropUnifiedTab(onlyTab.id, {
        groupId: sourceGroupId,
        splitDirection: 'down'
      })

      expect(moved).toBe(false)
      const state = store.getState()
      expect(state.groupsByWorktree[WT]).toHaveLength(1)
      expect(state.groupsByWorktree[WT][0].tabOrder).toEqual([onlyTab.id])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: sourceGroupId })
    })

    it('treats splitting the only tab onto the adjacent sibling edge as a no-op', () => {
      store.getState().createUnifiedTab(WT, 'editor', {
        id: 'file-a.ts',
        label: 'file-a.ts'
      })
      const right = store.getState().createUnifiedTab(WT, 'terminal', {
        id: 'terminal-1',
        label: 'Terminal 1'
      })
      const leftGroupId = store.getState().groupsByWorktree[WT][0].id

      expect(
        store.getState().dropUnifiedTab(right.id, {
          groupId: leftGroupId,
          splitDirection: 'right'
        })
      ).toBe(true)

      const rightGroupId = store
        .getState()
        .unifiedTabsByWorktree[WT].find((tab) => tab.id === right.id)?.groupId
      expect(rightGroupId).toBeTruthy()

      const moved = store.getState().dropUnifiedTab(right.id, {
        groupId: leftGroupId,
        splitDirection: 'right'
      })

      expect(moved).toBe(false)
      expect(
        store.getState().unifiedTabsByWorktree[WT].find((tab) => tab.id === right.id)?.groupId
      ).toBe(rightGroupId)
    })
  })

  describe('tabOrder dedupe', () => {
    it('deduplicates drag reorder payloads before persisting group order', () => {
      const first = store.getState().createUnifiedTab(WT, 'terminal')
      const second = store.getState().createUnifiedTab(WT, 'terminal')

      const groupId = store.getState().groupsByWorktree[WT][0].id
      store.getState().reorderUnifiedTabs(groupId, [second.id, first.id, second.id, first.id])

      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual([second.id, first.id])
    })
  })
})
