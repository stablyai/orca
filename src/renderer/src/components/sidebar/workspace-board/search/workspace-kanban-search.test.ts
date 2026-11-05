import { describe, expect, it } from 'vitest'

import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { matchWorkspaceBoardWorktrees } from './workspace-kanban-search'

function worktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    repoId: 'repo-a',
    displayName: 'Workspace',
    path: `/${overrides.id}`,
    branch: 'main',
    baseBranch: 'main',
    isPinned: false,
    sortOrder: 1,
    hostId: 'local',
    ...overrides
  } as Worktree
}

const repoMap = new Map<string, Repo>([
  ['repo-a', { id: 'repo-a', displayName: 'orca' } as Repo],
  ['repo-b', { id: 'repo-b', displayName: 'atlas' } as Repo]
])

function match(worktrees: Worktree[], query: string): ReadonlySet<string> | null {
  return matchWorkspaceBoardWorktrees({ worktrees, query, repoMap })
}

function identities(...worktrees: Worktree[]): Set<string> {
  return new Set(worktrees.map(getWorktreeHostIdentity))
}

describe('matchWorkspaceBoardWorktrees', () => {
  it('separates two same-id host rows', () => {
    const local = worktree({ id: 'shared', branch: 'refs/heads/local-only' })
    const remote = worktree({
      id: local.id,
      hostId: 'ssh:box',
      branch: 'refs/heads/remote-only'
    })

    expect(match([local, remote], 'local-only')).toEqual(identities(local))
    expect(match([local, remote], 'remote-only')).toEqual(identities(remote))
    expect(match([local], 'local-only')).toEqual(identities(local))
  })
})
