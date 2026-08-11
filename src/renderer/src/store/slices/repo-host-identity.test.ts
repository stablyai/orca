import { describe, expect, it } from 'vitest'
import { findRepoForHost } from './repo-host-identity'

describe('findRepoForHost', () => {
  it('fails closed when an explicit transport host contains multiple physical owners', () => {
    const repos = [
      {
        id: 'shared-repo',
        executionHostId: 'runtime:hub' as const,
        connectionId: null
      },
      {
        id: 'shared-repo',
        executionHostId: 'runtime:hub' as const,
        connectionId: 'builder'
      }
    ]

    expect(findRepoForHost(repos, 'shared-repo', { hostId: 'runtime:hub' })).toBeNull()
  })

  it('returns the sole repo on an explicit host', () => {
    const local = { id: 'shared-repo', connectionId: null }
    const remote = { id: 'shared-repo', executionHostId: 'runtime:hub' as const }

    expect(findRepoForHost([local, remote], 'shared-repo', { hostId: 'runtime:hub' })).toBe(remote)
  })
})
