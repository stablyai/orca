// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { DATABASE_FOCUS_EVENT, openOrFocusDatabaseTab } from './database-tab-actions'

const fixture = vi.hoisted(() => {
  const worktree = { id: 'repo::main', repoId: 'repo', hostId: 'local' as const }
  return {
    state: {
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'local',
      activeGroupIdByWorktree: { [worktree.id]: 'group-a' },
      unifiedTabsByWorktree: {} as Record<string, Tab[]>,
      worktreesByRepo: { repo: [worktree] },
      folderWorkspaces: [],
      getKnownWorktreeById: vi.fn(),
      activateTab: vi.fn(),
      setActiveTabType: vi.fn(),
      createUnifiedTab: vi.fn()
    },
    worktree
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => fixture.state } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    entityId: id,
    worktreeId: fixture.worktree.id,
    groupId: 'group-a',
    contentType: 'database',
    executionHostId: 'local',
    label: 'Database',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

describe('open or focus project database', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fixture.state.getKnownWorktreeById.mockReturnValue(fixture.worktree)
    fixture.state.createUnifiedTab.mockReturnValue(tab('created'))
    fixture.state.unifiedTabsByWorktree = {}
    fixture.state.worktreesByRepo = { repo: [fixture.worktree] }
  })

  it('focuses the existing query in the active group without creating another tab', () => {
    fixture.state.unifiedTabsByWorktree[fixture.worktree.id] = [
      tab('recent-other-group', { groupId: 'group-b', lastFocusedAt: 100 }),
      tab('active-group')
    ]
    const focus = vi.fn()
    window.addEventListener(DATABASE_FOCUS_EVENT, focus)
    try {
      expect(openOrFocusDatabaseTab(fixture.worktree.id)).toBe('active-group')
      expect(fixture.state.activateTab).toHaveBeenCalledWith('active-group')
      expect(fixture.state.setActiveTabType).toHaveBeenCalledWith('database')
      expect(fixture.state.createUnifiedTab).not.toHaveBeenCalled()
      expect(focus).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(DATABASE_FOCUS_EVENT, focus)
    }
  })

  it('returns to the most recently focused query when another split is active', () => {
    fixture.state.unifiedTabsByWorktree[fixture.worktree.id] = [
      tab('older', { groupId: 'group-b', lastFocusedAt: 10 }),
      tab('newer', { groupId: 'group-c', lastFocusedAt: 20 })
    ]
    expect(openOrFocusDatabaseTab(fixture.worktree.id)).toBe('newer')
  })

  it('creates a project-scoped read-only query instead of reusing a tab from a different host', () => {
    fixture.state.unifiedTabsByWorktree[fixture.worktree.id] = [
      tab('remote', { executionHostId: 'runtime:other' })
    ]
    expect(openOrFocusDatabaseTab(fixture.worktree.id)).toBe('created')
    expect(fixture.state.createUnifiedTab).toHaveBeenCalledWith(
      fixture.worktree.id,
      'database',
      expect.objectContaining({
        targetGroupId: 'group-a',
        database: expect.objectContaining({ readOnly: true })
      })
    )
  })

  it('does not create a database tab after its project disappears', () => {
    fixture.state.getKnownWorktreeById.mockReturnValue(null)
    expect(openOrFocusDatabaseTab(fixture.worktree.id)).toBeNull()
    expect(fixture.state.createUnifiedTab).not.toHaveBeenCalled()
  })
})
