import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '../types'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createTabsSliceMockApi()

const WT = 'repo1::/path/wt1'
const SPLIT = { sourceGroupId: 'unused', splitDirection: 'down' } as const

type Store = ReturnType<typeof createTestStore>

function seededStore(): { store: Store; sourceGroupId: string } {
  const store = createTestStore()
  seedStore(store, {
    activeWorktreeId: WT,
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  store.getState().createTab(WT, undefined, undefined, { id: 'terminal-1' })
  return { store, sourceGroupId: store.getState().groupsByWorktree[WT][0].id }
}

/** The layout fields a split create touches, with minted group ids replaced by stable names. */
function layoutProjection(state: AppState, sourceGroupId: string, splitGroupId: string): unknown {
  const projected = {
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    groupsByWorktree: state.groupsByWorktree,
    layoutByWorktree: state.layoutByWorktree,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    tabsByWorktree: state.tabsByWorktree,
    activeTabId: state.activeTabId,
    activeTabIdByWorktree: state.activeTabIdByWorktree,
    activeTabType: state.activeTabType,
    activeTabTypeByWorktree: state.activeTabTypeByWorktree
  }
  return JSON.parse(
    JSON.stringify(projected)
      .replaceAll(sourceGroupId, 'source-group')
      .replaceAll(splitGroupId, 'split-group')
  )
}

function newGroupId(state: AppState, sourceGroupId: string): string {
  const group = state.groupsByWorktree[WT].find((entry) => entry.id !== sourceGroupId)
  if (!group) {
    throw new Error('expected a split group')
  }
  return group.id
}

/** Every published state's groups for WT; an empty one would render as a blank pane. */
function recordPublishedEmptyGroups(store: Store): { emptyGroups: string[]; updates: number } {
  const emptyGroups: string[] = []
  const record = { emptyGroups, updates: 0 }
  store.subscribe((state) => {
    record.updates += 1
    for (const group of state.groupsByWorktree[WT] ?? []) {
      if (group.tabOrder.length === 0) {
        record.emptyGroups.push(group.id)
      }
    }
  })
  return record
}

describe('creating a tab directly into a new split', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([true, false])(
    'createTab ends where the empty-split-then-create chain ended (activate split group: %s)',
    (activate) => {
      const chained = seededStore()
      const chainedGroupId = chained.store
        .getState()
        .createEmptySplitGroup(WT, chained.sourceGroupId, 'down', { activate })
      chained.store.getState().createTab(WT, chainedGroupId ?? undefined, undefined, {
        id: 'terminal-2'
      })

      const atomic = seededStore()
      const published = recordPublishedEmptyGroups(atomic.store)
      atomic.store.getState().createTab(WT, undefined, undefined, {
        id: 'terminal-2',
        split: { ...SPLIT, sourceGroupId: atomic.sourceGroupId, activate }
      })

      // Switch on, a second publication marks the new pane as starting in main.
      expect(published).toEqual({ emptyGroups: [], updates: ORCA_LAYOUT_OWNER_IS_MAIN ? 2 : 1 })
      expect(
        Object.keys(atomic.store.getState().terminalPaneStartsByPaneKey).filter((key) =>
          key.startsWith('terminal-2:')
        )
      ).toHaveLength(ORCA_LAYOUT_OWNER_IS_MAIN ? 1 : 0)
      expect(
        layoutProjection(
          atomic.store.getState(),
          atomic.sourceGroupId,
          newGroupId(atomic.store.getState(), atomic.sourceGroupId)
        )
      ).toEqual(layoutProjection(chained.store.getState(), chained.sourceGroupId, chainedGroupId!))
    }
  )

  it.each([true, false])(
    'createUnifiedTab ends where the empty-split-then-create chain ended (activate tab: %s)',
    (activate) => {
      const chained = seededStore()
      const chainedGroupId = chained.store
        .getState()
        .createEmptySplitGroup(WT, chained.sourceGroupId, 'down', { activate: false })
      chained.store.getState().createUnifiedTab(WT, 'browser', {
        id: 'browser-1',
        targetGroupId: chainedGroupId!,
        activate
      })

      const atomic = seededStore()
      const published = recordPublishedEmptyGroups(atomic.store)
      atomic.store.getState().createUnifiedTab(WT, 'browser', {
        id: 'browser-1',
        split: { ...SPLIT, sourceGroupId: atomic.sourceGroupId, activate: false },
        activate
      })

      expect(published).toEqual({ emptyGroups: [], updates: 1 })
      expect(
        layoutProjection(
          atomic.store.getState(),
          atomic.sourceGroupId,
          newGroupId(atomic.store.getState(), atomic.sourceGroupId)
        )
      ).toEqual(layoutProjection(chained.store.getState(), chained.sourceGroupId, chainedGroupId!))
    }
  )

  it('records the pane interaction the empty split used to record', () => {
    const { store, sourceGroupId } = seededStore()
    const recordFeatureInteraction = vi.fn()
    store.setState({ recordFeatureInteraction })

    store.getState().createTab(WT, undefined, undefined, {
      split: { ...SPLIT, sourceGroupId }
    })

    expect(recordFeatureInteraction).toHaveBeenCalledWith('terminal-panes')
  })
})
