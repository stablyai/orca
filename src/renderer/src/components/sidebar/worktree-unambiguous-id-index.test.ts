import { describe, expect, it } from 'vitest'
import { buildUnambiguousWorktreeIdIndex } from './worktree-unambiguous-id-index'
import type { Worktree } from '../../../../shared/worktree/types'

function worktree(id: string, hostId: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo',
    path: `/repo/${id}`,
    branch: id,
    isMainWorktree: false,
    hostId
  } as Worktree
}

describe('buildUnambiguousWorktreeIdIndex', () => {
  it('drops bare ids claimed by multiple hosts', () => {
    const local = worktree('repo::feature', 'local')
    const remote = worktree('repo::feature', 'ssh:host')

    expect(buildUnambiguousWorktreeIdIndex([local, remote]).has('repo::feature')).toBe(false)
  })

  it('keeps later unique ids after an ambiguity is found', () => {
    const local = worktree('repo::feature', 'local')
    const remote = worktree('repo::feature', 'ssh:host')
    const other = worktree('repo::other', 'local')

    expect(buildUnambiguousWorktreeIdIndex([local, remote, other]).get('repo::other')).toBe(other)
  })
})
