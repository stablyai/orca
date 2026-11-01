import { describe, expect, expectTypeOf, it } from 'vitest'
import { getRepoHostIdentity, type HostScopedRepoKey } from './repo-host-identity'

// Why: frozen bytes (D25); a repo's host comes from executionHostId, then connectionId.
describe('getRepoHostIdentity golden bytes', () => {
  it('composes the repo key from the repo host', () => {
    expect(getRepoHostIdentity({ id: 'r', connectionId: null })).toBe('local\0r')
    expect(getRepoHostIdentity({ id: 'r', connectionId: 'box 1' })).toBe('ssh:box%201\0r')
    expect(
      getRepoHostIdentity({ id: 'r', connectionId: null, executionHostId: 'runtime:env' })
    ).toBe('runtime:env\0r')
    expectTypeOf(getRepoHostIdentity({ id: 'r' })).toEqualTypeOf<HostScopedRepoKey>()
  })
})
