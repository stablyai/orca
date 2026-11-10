import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from '../../testing/app-store-test-fixture'

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

  describe('setTabGroupSplitRatio', () => {
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
      expect((store.getState().layoutByWorktree[WT] as { ratio: number }).ratio).toBe(0.5004)
      unsubscribe()
    })
  })

  describe('move/copy/merge group operations', () => {
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
  })
})
