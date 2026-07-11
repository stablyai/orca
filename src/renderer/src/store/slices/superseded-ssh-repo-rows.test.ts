import { describe, it, expect } from 'vitest'
import { pruneSupersededSshRepoRows } from './superseded-ssh-repo-rows'
import type { Repo } from '../../../../shared/types'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'r',
    path: '/p',
    displayName: 'r',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

describe('pruneSupersededSshRepoRows', () => {
  it('drops a stale dead-SSH row when a live-host sibling shares the id', () => {
    // The re-adoption leftover: same id on a dead target + a live one.
    const repos = [
      repo({ id: 'shared', connectionId: 'ssh-dead' }),
      repo({ id: 'shared', connectionId: 'ssh-live' })
    ]
    const result = pruneSupersededSshRepoRows(repos, new Set(['ssh-live']))
    expect(result.map((r) => r.connectionId)).toEqual(['ssh-live'])
  })

  it('KEEPS a lone project-only ghost (no live sibling) so it can still be forgotten', () => {
    const repos = [repo({ id: 'ghost', connectionId: 'ssh-dead' })]
    const result = pruneSupersededSshRepoRows(repos, new Set())
    expect(result).toHaveLength(1)
    expect(result[0].connectionId).toBe('ssh-dead')
  })

  it('drops a dead-SSH row superseded by a LOCAL sibling', () => {
    // A repo id on both local and a removed SSH host: the local row is the live
    // sibling, so the SSH ghost is a re-adoption/duplicate leftover → drop it.
    const repos = [repo({ id: 'shared' }), repo({ id: 'shared', connectionId: 'ssh-dead' })]
    const result = pruneSupersededSshRepoRows(repos, new Set())
    expect(result.map((r) => r.connectionId ?? 'local')).toEqual(['local'])
  })

  it('leaves live SSH rows untouched', () => {
    const repos = [repo({ id: 'a', connectionId: 'ssh-live' }), repo({ id: 'b' })]
    const result = pruneSupersededSshRepoRows(repos, new Set(['ssh-live']))
    expect(result).toHaveLength(2)
  })

  it('never prunes runtime-owned SSH rows', () => {
    const repos = [
      repo({ id: 'shared', connectionId: 'runtime-ssh-abc' }),
      repo({ id: 'shared', connectionId: 'ssh-live' })
    ]
    const result = pruneSupersededSshRepoRows(repos, new Set(['ssh-live']))
    expect(result).toHaveLength(2)
  })
})
