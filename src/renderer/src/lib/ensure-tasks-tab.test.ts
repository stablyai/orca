import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockStoreState = vi.hoisted(() => ({
  activeGroupIdByWorktree: {} as Record<string, string>,
  activeWorktreeId: 'repo-1::/repo-1',
  activateTab: vi.fn(),
  createUnifiedTab: vi.fn(),
  focusGroup: vi.fn(),
  getKnownWorktreeById: (worktreeId: string) =>
    worktreeId === 'repo-1::/repo-1' ? { repoId: 'repo-1' } : undefined,
  groupsByWorktree: {} as Record<string, { id: string }[]>,
  repos: [] as { id: string; kind?: string }[],
  setActiveTabType: vi.fn(),
  unifiedTabsByWorktree: {} as Record<
    string,
    { id: string; groupId: string; contentType: string }[]
  >
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

const WORKTREE_ID = 'repo-1::/repo-1'

describe('ensureTasksTab', () => {
  beforeEach(() => {
    mockStoreState.activeGroupIdByWorktree = { [WORKTREE_ID]: 'group-1' }
    mockStoreState.activeWorktreeId = WORKTREE_ID
    mockStoreState.groupsByWorktree = { [WORKTREE_ID]: [{ id: 'group-1' }] }
    mockStoreState.repos = [{ id: 'repo-1', kind: 'git' }]
    mockStoreState.unifiedTabsByWorktree = { [WORKTREE_ID]: [] }
    mockStoreState.activateTab.mockReset()
    mockStoreState.createUnifiedTab.mockReset()
    mockStoreState.focusGroup.mockReset()
    mockStoreState.setActiveTabType.mockReset()
    vi.resetModules()
  })

  // Why: one tasks tab per worktree — reopening must focus, not duplicate.
  it('focuses the existing tasks tab instead of creating a duplicate', async () => {
    mockStoreState.unifiedTabsByWorktree = {
      [WORKTREE_ID]: [{ id: 'tasks-1', groupId: 'group-1', contentType: 'tasks' }]
    }
    const { ensureTasksTab } = await import('./ensure-tasks-tab')

    expect(ensureTasksTab(WORKTREE_ID)).toBe('tasks-1')

    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.activateTab).toHaveBeenCalledWith('tasks-1')
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith(WORKTREE_ID, 'group-1')
    expect(mockStoreState.setActiveTabType).toHaveBeenCalledWith('tasks')
  })

  it('creates a tasks tab in the active group when none exists', async () => {
    mockStoreState.createUnifiedTab.mockReturnValue({ id: 'tasks-new', groupId: 'group-1' })
    const { ensureTasksTab } = await import('./ensure-tasks-tab')

    expect(ensureTasksTab(WORKTREE_ID)).toBe('tasks-new')

    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      'tasks',
      expect.objectContaining({ targetGroupId: 'group-1', activate: true })
    )
    expect(mockStoreState.setActiveTabType).toHaveBeenCalledWith('tasks')
  })

  // Why: tasks are provider work items fetched per repo — a non-git workspace
  // has no task source, so the tab must refuse to open.
  it('returns null when the worktree repo is not git-backed', async () => {
    mockStoreState.repos = [{ id: 'repo-1', kind: 'folder' }]
    const { ensureTasksTab } = await import('./ensure-tasks-tab')

    expect(ensureTasksTab(WORKTREE_ID)).toBeNull()
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
  })
})
