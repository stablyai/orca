import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '../../types'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'

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

function newGroupId(state: AppState, sourceGroupId: string): string {
  const group = state.groupsByWorktree[WT].find((entry) => entry.id !== sourceGroupId)
  if (!group) {
    throw new Error('expected a split group')
  }
  return group.id
}

/** Every published group's membership; an empty group would paint a blank pane. */
function recordPublishedEmptyGroups(store: Store): { emptyGroups: string[] } {
  const record: { emptyGroups: string[] } = { emptyGroups: [] }
  store.subscribe((state) => {
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

  it('terminal create fills and selects its split with split activation true', () => {
    const atomic = seededStore()
    const published = recordPublishedEmptyGroups(atomic.store)
    atomic.store.getState().createTab(WT, undefined, undefined, {
      id: 'terminal-2',
      split: { ...SPLIT, sourceGroupId: atomic.sourceGroupId, activate: true }
    })
    const state = atomic.store.getState()
    const splitGroupId = newGroupId(state, atomic.sourceGroupId)
    expect(published.emptyGroups).toEqual([])
    expect(state.groupsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: atomic.sourceGroupId, tabOrder: ['terminal-1'] }),
      expect.objectContaining({
        id: splitGroupId,
        tabOrder: ['terminal-2'],
        activeTabId: 'terminal-2'
      })
    ])
    expect(state.unifiedTabsByWorktree[WT]).toContainEqual(
      expect.objectContaining({
        id: 'terminal-2',
        entityId: 'terminal-2',
        groupId: splitGroupId,
        contentType: 'terminal'
      })
    )
    expect(state.layoutByWorktree[WT]).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: atomic.sourceGroupId },
      second: { type: 'leaf', groupId: splitGroupId }
    })
    expect(state.tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['terminal-1', 'terminal-2'])
    expect(state.activeGroupIdByWorktree[WT]).toBe(splitGroupId)
    expect(state.activeTabId).toBe('terminal-2')
    expect(state.activeTabIdByWorktree[WT]).toBe('terminal-2')
  })

  it('terminal create fills and selects its split with split activation false', () => {
    const atomic = seededStore()
    const published = recordPublishedEmptyGroups(atomic.store)
    atomic.store.getState().createTab(WT, undefined, undefined, {
      id: 'terminal-2',
      split: { ...SPLIT, sourceGroupId: atomic.sourceGroupId, activate: false }
    })
    const state = atomic.store.getState()
    const splitGroupId = newGroupId(state, atomic.sourceGroupId)
    expect(published.emptyGroups).toEqual([])
    expect(state.groupsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: atomic.sourceGroupId, tabOrder: ['terminal-1'] }),
      expect.objectContaining({
        id: splitGroupId,
        tabOrder: ['terminal-2'],
        activeTabId: 'terminal-2'
      })
    ])
    expect(state.unifiedTabsByWorktree[WT]).toContainEqual(
      expect.objectContaining({
        id: 'terminal-2',
        entityId: 'terminal-2',
        groupId: splitGroupId,
        contentType: 'terminal'
      })
    )
    expect(state.layoutByWorktree[WT]).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: atomic.sourceGroupId },
      second: { type: 'leaf', groupId: splitGroupId }
    })
    expect(state.tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['terminal-1', 'terminal-2'])
    expect(state.activeGroupIdByWorktree[WT]).toBe(splitGroupId)
    expect(state.activeTabId).toBe('terminal-2')
    expect(state.activeTabIdByWorktree[WT]).toBe('terminal-2')
  })

  it('browser create fills an inactive split with tab activation true', () => {
    const atomic = seededStore()
    const published = recordPublishedEmptyGroups(atomic.store)
    atomic.store.getState().createUnifiedTab(WT, 'browser', {
      id: 'browser-1',
      split: { ...SPLIT, sourceGroupId: atomic.sourceGroupId, activate: false },
      activate: true
    })
    const state = atomic.store.getState()
    const splitGroupId = newGroupId(state, atomic.sourceGroupId)
    expect(published.emptyGroups).toEqual([])
    expect(state.groupsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: atomic.sourceGroupId, tabOrder: ['terminal-1'] }),
      expect.objectContaining({
        id: splitGroupId,
        tabOrder: ['browser-1'],
        activeTabId: 'browser-1'
      })
    ])
    expect(state.unifiedTabsByWorktree[WT]).toContainEqual(
      expect.objectContaining({
        id: 'browser-1',
        entityId: 'browser-1',
        groupId: splitGroupId,
        contentType: 'browser'
      })
    )
    expect(state.layoutByWorktree[WT]).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: atomic.sourceGroupId },
      second: { type: 'leaf', groupId: splitGroupId }
    })
    expect(state.tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['terminal-1'])
    expect(state.activeGroupIdByWorktree[WT]).toBe(atomic.sourceGroupId)
    expect(state.activeTabId).toBe('terminal-1')
    expect(state.activeTabIdByWorktree[WT]).toBe('terminal-1')
    expect(
      state.unifiedTabsByWorktree[WT].find((tab) => tab.id === 'browser-1')?.lastFocusedAt
    ).toBe(1_791_979_200_000)
  })

  it('browser create fills an inactive split with tab activation false', () => {
    const atomic = seededStore()
    const published = recordPublishedEmptyGroups(atomic.store)
    atomic.store.getState().createUnifiedTab(WT, 'browser', {
      id: 'browser-1',
      split: { ...SPLIT, sourceGroupId: atomic.sourceGroupId, activate: false },
      activate: false
    })
    const state = atomic.store.getState()
    const splitGroupId = newGroupId(state, atomic.sourceGroupId)
    expect(published.emptyGroups).toEqual([])
    expect(state.groupsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: atomic.sourceGroupId, tabOrder: ['terminal-1'] }),
      expect.objectContaining({
        id: splitGroupId,
        tabOrder: ['browser-1'],
        activeTabId: 'browser-1'
      })
    ])
    expect(state.unifiedTabsByWorktree[WT]).toContainEqual(
      expect.objectContaining({
        id: 'browser-1',
        entityId: 'browser-1',
        groupId: splitGroupId,
        contentType: 'browser'
      })
    )
    expect(state.layoutByWorktree[WT]).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: atomic.sourceGroupId },
      second: { type: 'leaf', groupId: splitGroupId }
    })
    expect(state.tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['terminal-1'])
    expect(state.activeGroupIdByWorktree[WT]).toBe(atomic.sourceGroupId)
    expect(state.activeTabId).toBe('terminal-1')
    expect(state.activeTabIdByWorktree[WT]).toBe('terminal-1')
    expect(
      state.unifiedTabsByWorktree[WT].find((tab) => tab.id === 'browser-1')?.lastFocusedAt
    ).toBe(undefined)
  })
})

describe('creating a tab shown in another pane', () => {
  it('shows the new tab in its pane without making that pane the active one', () => {
    const { store, sourceGroupId } = seededStore()
    const browserGroupId = store
      .getState()
      .createEmptySplitGroup(WT, sourceGroupId, 'right', { activate: false })!
    store.getState().createUnifiedTab(WT, 'browser', {
      id: 'browser-old',
      targetGroupId: browserGroupId,
      activate: false
    })
    store.getState().createUnifiedTab(WT, 'browser', {
      id: 'browser-new',
      targetGroupId: browserGroupId,
      activate: false,
      showInGroup: true
    })

    const state = store.getState()
    expect(state.groupsByWorktree[WT].find((g) => g.id === browserGroupId)?.activeTabId).toBe(
      'browser-new'
    )
    expect(state.activeGroupIdByWorktree[WT]).toBe(sourceGroupId)
    expect(
      state.unifiedTabsByWorktree[WT].find((tab) => tab.id === 'browser-new')?.lastFocusedAt
    ).toBeUndefined()
  })
})
