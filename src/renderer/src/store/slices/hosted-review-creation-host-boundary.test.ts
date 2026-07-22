import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { _findHostedReviewRepoByPathForTest } from './hosted-review'

function repo(path: string, executionHostId: Repo['executionHostId']): Repo {
  return {
    id: 'shared-repo',
    path,
    displayName: path,
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git',
    connectionId: executionHostId?.startsWith('ssh:') ? 'ssh-1' : null,
    executionHostId
  }
}

describe('hosted-review creation repository identity', () => {
  const local = repo('/local/repo', 'local')
  const ssh = repo('/ssh/repo', 'ssh:ssh-1')
  const runtime = repo('/runtime/repo', 'runtime:env-1')

  it('selects the explicit owner when repository ids overlap', () => {
    expect(
      _findHostedReviewRepoByPathForTest([local, runtime, ssh], ssh.path, ssh.id, 'ssh:ssh-1')
    ).toBe(ssh)
  })

  it('uses an exact id-and-path tuple for a legacy caller', () => {
    expect(_findHostedReviewRepoByPathForTest([runtime, local], local.path, local.id)).toBe(local)
  })

  it('fails closed when an explicit owner has no matching repository', () => {
    expect(
      _findHostedReviewRepoByPathForTest([local, runtime], '/missing/repo', local.id, 'ssh:ssh-1')
    ).toBeUndefined()
  })
})
