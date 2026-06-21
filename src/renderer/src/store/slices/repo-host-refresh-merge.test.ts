import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/types'
import { mergeFetchedReposForHost } from './repo-host-refresh-merge'

function repo(id: string, hostId: ExecutionHostId, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${hostId}/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId: hostId,
    ...overrides
  }
}

function idsByHost(repos: readonly Repo[]): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const entry of repos) {
    const hostId = getRepoExecutionHostId(entry)
    result[hostId] ??= []
    result[hostId].push(entry.id)
  }
  return result
}

describe('mergeFetchedReposForHost', () => {
  it('refreshes one host without dropping repos owned by another host', () => {
    const previous = [
      repo('local-a', 'local'),
      repo('runtime-a', 'runtime:env-a'),
      repo('runtime-stale', 'runtime:env-a')
    ]

    const merged = mergeFetchedReposForHost(
      previous,
      [repo('runtime-a', 'runtime:env-a', { displayName: 'runtime renamed' })],
      'runtime:env-a'
    )

    expect(idsByHost(merged)).toEqual({
      local: ['local-a'],
      'runtime:env-a': ['runtime-a']
    })
    expect(merged.find((entry) => entry.id === 'runtime-a')?.displayName).toBe('runtime renamed')
  })

  it('matches repos by host and id instead of id alone', () => {
    const previous = [
      repo('same-id', 'local', { path: '/local/orca' }),
      repo('same-id', 'runtime:env-a', { path: '/srv/orca-old' })
    ]

    const merged = mergeFetchedReposForHost(
      previous,
      [repo('same-id', 'runtime:env-a', { path: '/srv/orca-new' })],
      'runtime:env-a'
    )

    expect(merged).toHaveLength(2)
    expect(merged.find((entry) => getRepoExecutionHostId(entry) === 'local')?.path).toBe(
      '/local/orca'
    )
    expect(merged.find((entry) => getRepoExecutionHostId(entry) === 'runtime:env-a')?.path).toBe(
      '/srv/orca-new'
    )
  })

  it('adds a same-id repo on a new host without replacing the existing host repo', () => {
    const previous = [repo('same-id', 'local', { path: '/local/orca' })]

    const merged = mergeFetchedReposForHost(
      previous,
      [repo('same-id', 'runtime:env-a', { path: '/srv/orca' })],
      'runtime:env-a'
    )

    expect(merged).toHaveLength(2)
    expect(idsByHost(merged)).toEqual({
      local: ['same-id'],
      'runtime:env-a': ['same-id']
    })
  })
})
