import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import { countEstimatedInactiveWorkspaces } from './inactive-workspace-estimate'

const NOW = 1_800_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000

const GIT_REPO = { id: 'repo-1', path: '/repo', displayName: 'Repo' } as Repo
const FOLDER_REPO = {
  id: 'folder-1',
  path: '/folder',
  displayName: 'Folder',
  kind: 'folder'
} as Repo

const REPOS = new Map<string, Repo>([
  [GIT_REPO.id, GIT_REPO],
  [FOLDER_REPO.id, FOLDER_REPO]
])

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo-feature',
    repoId: 'repo-1',
    path: '/repo-feature',
    isMainWorktree: false,
    isArchived: false,
    lastActivityAt: NOW - 90 * DAY_MS,
    ...overrides
  } as Worktree
}

describe('countEstimatedInactiveWorkspaces', () => {
  it('counts workspaces idle past the cleanup threshold', () => {
    expect(countEstimatedInactiveWorkspaces([makeWorktree()], REPOS, NOW)).toBe(1)
  })

  it('does not count a missing activity stamp as ancient', () => {
    const worktrees = [
      makeWorktree({ lastActivityAt: 0 }),
      makeWorktree({ lastActivityAt: Number.NaN })
    ]

    expect(countEstimatedInactiveWorkspaces(worktrees, REPOS, NOW)).toBe(0)
  })

  it('falls back to the creation stamp when activity was never recorded', () => {
    const recent = makeWorktree({ lastActivityAt: 0, createdAt: NOW - DAY_MS })
    const old = makeWorktree({ lastActivityAt: 0, createdAt: NOW - 90 * DAY_MS })

    expect(countEstimatedInactiveWorkspaces([recent, old], REPOS, NOW)).toBe(1)
  })

  it('skips main worktrees, folder workspaces, and unknown repos', () => {
    const worktrees = [
      makeWorktree({ isMainWorktree: true }),
      makeWorktree({ repoId: FOLDER_REPO.id }),
      makeWorktree({ repoId: 'gone' })
    ]

    expect(countEstimatedInactiveWorkspaces(worktrees, REPOS, NOW)).toBe(0)
  })

  it('uses the shorter archived threshold', () => {
    const worktree = makeWorktree({ isArchived: true, lastActivityAt: NOW - 10 * DAY_MS })

    expect(countEstimatedInactiveWorkspaces([worktree], REPOS, NOW)).toBe(1)
  })
})
