import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import { findRepoForWorktreeOwner } from './repo-host-identity'

function repo(hostId: Repo['executionHostId'], path: string): Repo {
  return {
    id: 'repo-1',
    path,
    displayName: path,
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git',
    connectionId: null,
    executionHostId: hostId
  }
}

function worktree(hostId?: Worktree['hostId']): Pick<Worktree, 'repoId' | 'hostId'> {
  return { repoId: 'repo-1', ...(hostId ? { hostId } : {}) }
}

describe('findRepoForWorktreeOwner', () => {
  it('uses an explicit worktree owner when repo ids overlap', () => {
    const local = repo('local', '/local')
    const runtime = repo('runtime:env-1', '/runtime')

    expect(findRepoForWorktreeOwner([local, runtime], worktree('runtime:env-1'))).toBe(runtime)
  })

  it('fails closed when an explicit worktree owner is unavailable', () => {
    const local = repo('local', '/local')

    expect(findRepoForWorktreeOwner([local], worktree('runtime:missing'))).toBeNull()
  })

  it('fails closed when the explicit owner matches duplicate repo records', () => {
    const first = repo('ssh:ssh-1', '/ssh/first')
    const second = repo('ssh:ssh-1', '/ssh/second')

    expect(findRepoForWorktreeOwner([first, second], worktree('ssh:ssh-1'))).toBeNull()
  })

  it('uses the only matching repo for a legacy hostless worktree', () => {
    const ssh = repo('ssh:ssh-1', '/ssh')

    expect(findRepoForWorktreeOwner([ssh], worktree())).toBe(ssh)
  })

  it('normalizes an ambiguous legacy hostless worktree to its unique local repo', () => {
    const runtime = repo('runtime:env-1', '/runtime')
    const local = repo('local', '/local')

    expect(findRepoForWorktreeOwner([runtime, local], worktree())).toBe(local)
  })

  it('fails closed when a legacy hostless worktree has no unique local owner', () => {
    const ssh = repo('ssh:ssh-1', '/ssh')
    const runtime = repo('runtime:env-1', '/runtime')

    expect(findRepoForWorktreeOwner([ssh, runtime], worktree())).toBeNull()
  })
})
