import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  getVisibleWorktreeIds,
  getVisibleWorktreeShortcutTargets,
  setVisibleWorktreeIds,
  setVisibleWorktreeShortcutTargets
} from './visible-worktrees'
import type { AppState } from '@/store/types'

import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

const initialState = useAppStore.getInitialState()

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo1',
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  } as Worktree
}

function makeRepo(id = 'repo1', overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    defaultBranch: 'main',
    connectionId: null,
    ...overrides
  } as unknown as Repo
}

/** Clear the published order so the closed-sidebar fallback must recompute it from store fields. */
function seedStore(worktrees: Worktree[], overrides: Partial<AppState> = {}): void {
  useAppStore.setState(
    {
      ...initialState,
      repos: [makeRepo()],
      worktreesByRepo: { repo1: worktrees },
      // Why showSleepingWorkspaces: fixtures have no PTYs, so the activity filter
      // would otherwise drop every workspace before ordering runs.
      showSleepingWorkspaces: true,
      groupBy: 'repo',
      sortBy: 'manual',
      ...overrides
    } as AppState,
    true
  )
  setVisibleWorktreeIds(null)
  setVisibleWorktreeShortcutTargets(null)
}

describe('closed-sidebar Cmd+1-9 ordering (#9497)', () => {
  afterEach(() => {
    setVisibleWorktreeIds(null)
    setVisibleWorktreeShortcutTargets(null)
    useAppStore.setState(initialState, true)
  })

  it('keeps same-id hosts as separate closed-sidebar shortcut positions', () => {
    seedStore([
      makeWorktree('repo1::/same', { hostId: 'local' }),
      makeWorktree('repo1::/same', { hostId: 'ssh:box' })
    ])

    expect(getVisibleWorktreeIds()).toEqual(['repo1::/same'])
    expect(getVisibleWorktreeShortcutTargets()).toEqual([
      { id: 'repo1::/same', executionHostId: 'local' },
      { id: 'repo1::/same', executionHostId: 'ssh:box' }
    ])
  })

  it('does not reconstruct a filtered same-id host in closed-sidebar shortcuts', () => {
    seedStore(
      [
        makeWorktree('repo1::/same', { hostId: 'local' }),
        makeWorktree('repo1::/same', { hostId: 'ssh:box' })
      ],
      { visibleWorkspaceHostIds: ['local'] }
    )

    expect(getVisibleWorktreeIds()).toEqual(['repo1::/same'])
    expect(getVisibleWorktreeShortcutTargets()).toEqual([
      { id: 'repo1::/same', executionHostId: 'local' }
    ])
  })
})
