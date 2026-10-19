import { describe, expect, it } from 'vitest'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  composeWorktreeHostIdentity
} from './worktree/host-qualified-identity'
import { parseExecutionHostId, UNRESOLVED_OWNER_HOST_ID } from './execution-host'
import {
  authorityKey,
  hostAuthorityFromOperationRoute,
  parseHostAuthorityKey,
  type HostAuthority
} from './host-authority'

const self = { kind: 'self' } as const
const env = (environmentId: string) => ({ kind: 'environment', environmentId }) as const

describe('authorityKey', () => {
  it.each<[HostAuthority, string]>([
    [{ endpoint: self, at: 'local' }, 'local'],
    [{ endpoint: self, at: 'ssh:box' }, 'ssh:box'],
    [{ endpoint: env('env/a'), at: 'local' }, 'runtime:env%2Fa'],
    [{ endpoint: env('env/a'), at: 'ssh:my%2Fbox' }, 'nested:env%2Fa/my%2Fbox']
  ])('keeps existing spellings and round-trips %j', (authority, key) => {
    expect(authorityKey(authority)).toBe(key)
    expect(parseHostAuthorityKey(key)).toEqual(authority)
  })

  it('gives nested authorities a key no host-id parser accepts', () => {
    const key = authorityKey({ endpoint: env('env-a'), at: 'ssh:box' })
    expect(parseExecutionHostId(key)).toBeNull()
    expect(
      getExecutionHostIdFromWorktreeHostIdentity(composeWorktreeHostIdentity(undefined, key))
    ).toBeUndefined()
  })

  it('never parses the unresolved-owner sentinel, plain or nested', () => {
    expect(parseHostAuthorityKey(UNRESOLVED_OWNER_HOST_ID)).toBeNull()
    expect(parseHostAuthorityKey('nested:unresolved-owner/box')).toBeNull()
    expect(parseHostAuthorityKey('nested:env-a')).toBeNull()
    expect(parseHostAuthorityKey('nested:env-a/box/extra')).toBeNull()
    expect(parseHostAuthorityKey('bogus')).toBeNull()
  })
})

describe('hostAuthorityFromOperationRoute', () => {
  it('reads the transport as the endpoint and the row host as the place on it', () => {
    expect(
      hostAuthorityFromOperationRoute({ executionHostId: 'ssh:t', runtimeEnvironmentId: 'env-a' })
    ).toEqual({ endpoint: env('env-a'), at: 'ssh:t' })
    expect(
      hostAuthorityFromOperationRoute({ executionHostId: 'local', runtimeEnvironmentId: 'env-a' })
    ).toEqual({ endpoint: env('env-a'), at: 'local' })
    expect(
      hostAuthorityFromOperationRoute({ executionHostId: null, runtimeEnvironmentId: 'env-a' })
    ).toEqual({ endpoint: env('env-a'), at: 'local' })
    expect(
      hostAuthorityFromOperationRoute({ executionHostId: 'ssh:t', runtimeEnvironmentId: null })
    ).toEqual({ endpoint: self, at: 'ssh:t' })
  })

  it('reports disagreeing hosts and refuses unusable ones', () => {
    expect(
      hostAuthorityFromOperationRoute({
        executionHostId: 'runtime:env-b',
        runtimeEnvironmentId: 'env-a'
      })
    ).toBe('contradictory')
    expect(
      hostAuthorityFromOperationRoute({
        executionHostId: UNRESOLVED_OWNER_HOST_ID,
        runtimeEnvironmentId: 'unresolved-owner'
      })
    ).toBeNull()
    expect(
      hostAuthorityFromOperationRoute({ executionHostId: 'garbage', runtimeEnvironmentId: null })
    ).toBeNull()
    expect(
      hostAuthorityFromOperationRoute({ executionHostId: null, runtimeEnvironmentId: null })
    ).toBeNull()
  })
})
