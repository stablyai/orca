import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { findGroupLinkedWorktreeIds } from './linked-worktree-groups'

function repo(
  id: string,
  projectGroupId: string | null,
  extra: { kind?: 'git' | 'folder'; executionHostId?: ExecutionHostId } = {}
) {
  return { id, projectGroupId, ...extra }
}

function worktree(id: string, repoId: string, isMainWorktree = true) {
  return { id, repoId, isMainWorktree, isArchived: false }
}

describe('findGroupLinkedWorktreeIds', () => {
  const repos = [repo('app', 'g1'), repo('lib', 'g1'), repo('docs', 'g2'), repo('solo', null)]
  const worktrees = [
    worktree('app-main', 'app'),
    worktree('app-feature', 'app', false),
    worktree('lib-main', 'lib'),
    worktree('lib-feature', 'lib', false),
    worktree('docs-main', 'docs'),
    worktree('solo-main', 'solo')
  ]

  it("links the main checkout of each other project in the active project's group", () => {
    expect(findGroupLinkedWorktreeIds(repos, worktrees, 'app-feature')).toEqual(['lib-main'])
  })

  it('links nothing for a project outside any group', () => {
    expect(findGroupLinkedWorktreeIds(repos, worktrees, 'solo-main')).toEqual([])
  })

  it('skips folder projects and projects on another host', () => {
    const mixed = [
      repo('app', 'g1'),
      repo('notes', 'g1', { kind: 'folder' }),
      repo('remote', 'g1', { executionHostId: 'runtime:box' })
    ]
    const trees = [
      worktree('app-main', 'app'),
      worktree('notes-main', 'notes'),
      worktree('remote-main', 'remote')
    ]
    expect(findGroupLinkedWorktreeIds(mixed, trees, 'app-main')).toEqual([])
  })
})
