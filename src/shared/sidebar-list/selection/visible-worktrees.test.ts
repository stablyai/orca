import { describe, expect, it } from 'vitest'
import { selectVisibleSidebarWorktrees } from './visible-worktrees'
import { NO_WORKSPACE_ROW_FILTERS } from '../../workspace-view/workspace-row-filters'
import type { Worktree } from '../../worktree/types'

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo-1',
    name: id,
    path: `/tmp/${id}`,
    branch: id,
    head: 'abc123',
    isMainWorktree: false,
    isArchived: false,
    isBare: false,
    isDetached: false,
    isLocked: false,
    isPrunable: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides
  } as Worktree
}

describe('selectVisibleSidebarWorktrees', () => {
  it('keeps forcedVisibleWorktreeIds visible even when filters would hide them', () => {
    const sleeping = makeWorktree('wt-sleeping')
    const defaultBranch = makeWorktree('wt-default', { isMainWorktree: true })
    const archived = makeWorktree('wt-archived', { isArchived: true })
    const ancestorByIdentity = new Map([
      ['local|wt-sleeping', sleeping],
      ['local|wt-default', defaultBranch]
    ])

    const result = selectVisibleSidebarWorktrees({
      rows: [sleeping, defaultBranch, archived],
      ancestorByIdentity,
      rankOf: () => 0,
      filters: {
        ...NO_WORKSPACE_ROW_FILTERS,
        filterRepoIds: [],
        hideSleepingWorkspaces: true,
        hideDefaultBranchWorkspace: true
      },
      facts: {
        isArchived: (w) => w.isArchived,
        isProjectHidden: () => false,
        isInHiddenProject: () => false,
        isFolderWorkspace: () => false,
        repoId: (w) => w.repoId,
        hostId: () => 'local',
        isOtherClient: () => false,
        isDefaultBranch: (w) => w.id === 'wt-default',
        isAutomationCreated: () => false,
        isCliCreated: () => false,
        isDetachedHead: () => false,
        isMainWorktree: (w) => w.isMainWorktree,
        isSleeping: (w) => w.id === 'wt-sleeping'
      },
      worktreeLineageById: {},
      filterRepoIds: [],
      forcedVisibleWorktreeIds: ['wt-sleeping', 'wt-default', 'wt-archived']
    })

    expect(result.map((w) => w.id)).toEqual(['wt-sleeping', 'wt-default'])
  })
})
