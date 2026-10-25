import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'

type AnchorStoreState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  reorderUnifiedTabs: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const state: { current: AnchorStoreState | null } = { current: null }
  return { state }
})

vi.mock('../store', () => ({
  useAppStore: { getState: () => mocks.state.current }
}))

import { insertUnifiedTabAfterAnchor } from './unified-tab-anchor-insertion'

const WT = 'wt-1'

function tab(id: string, groupId: string, isPinned = false): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPinned
  }
}

function seed(tabs: Tab[], groups: TabGroup[]): void {
  mocks.state.current = {
    unifiedTabsByWorktree: { [WT]: tabs },
    groupsByWorktree: { [WT]: groups },
    reorderUnifiedTabs: vi.fn()
  }
}

describe('insertUnifiedTabAfterAnchor', () => {
  beforeEach(() => {
    seed([], [])
  })

  it('moves a late terminal right after its anchor', () => {
    seed(
      [tab('A', 'g1'), tab('B', 'g1'), tab('C', 'g1'), tab('T', 'g1')],
      [{ id: 'g1', worktreeId: WT, activeTabId: 'A', tabOrder: ['A', 'B', 'C', 'T'] }]
    )
    insertUnifiedTabAfterAnchor(WT, 'T', 'A')
    expect(mocks.state.current?.reorderUnifiedTabs).toHaveBeenCalledWith(
      'g1',
      ['A', 'T', 'B', 'C'],
      {
        recordInteraction: false
      }
    )
  })

  it('keeps an unpinned terminal after the pinned prefix', () => {
    seed(
      [tab('P1', 'g1', true), tab('P2', 'g1', true), tab('C', 'g1'), tab('T', 'g1')],
      [{ id: 'g1', worktreeId: WT, activeTabId: 'P1', tabOrder: ['P1', 'P2', 'C', 'T'] }]
    )
    insertUnifiedTabAfterAnchor(WT, 'T', 'P1')
    expect(mocks.state.current?.reorderUnifiedTabs).toHaveBeenCalledWith(
      'g1',
      ['P1', 'P2', 'T', 'C'],
      {
        recordInteraction: false
      }
    )
  })

  it('is a no-op for a missing anchor or tabs in different groups', () => {
    seed(
      [tab('A', 'g1'), tab('T', 'g2')],
      [
        { id: 'g1', worktreeId: WT, activeTabId: 'A', tabOrder: ['A'] },
        { id: 'g2', worktreeId: WT, activeTabId: 'T', tabOrder: ['T'] }
      ]
    )
    insertUnifiedTabAfterAnchor(WT, 'T', 'A')
    insertUnifiedTabAfterAnchor(WT, 'T', 'missing')
    expect(mocks.state.current?.reorderUnifiedTabs).not.toHaveBeenCalled()
  })

  it('is a no-op when a stale group order lists a tab another group owns', () => {
    seed(
      [tab('A', 'g1'), tab('T', 'g2')],
      [
        { id: 'g1', worktreeId: WT, activeTabId: 'A', tabOrder: ['A', 'T'] },
        { id: 'g2', worktreeId: WT, activeTabId: 'T', tabOrder: ['T'] }
      ]
    )
    insertUnifiedTabAfterAnchor(WT, 'T', 'A')
    expect(mocks.state.current?.reorderUnifiedTabs).not.toHaveBeenCalled()
  })
})
