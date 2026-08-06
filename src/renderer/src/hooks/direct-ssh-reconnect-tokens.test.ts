import { describe, expect, it } from 'vitest'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { directSshAuthoritiesEqual } from './direct-ssh-reconnect-tokens'

const authority: DirectSshAuthority = {
  targetId: 'target-a',
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 1
}

describe('directSshAuthoritiesEqual', () => {
  it('fails closed when either authority is missing', () => {
    expect(directSshAuthoritiesEqual(null, null)).toBe(false)
    expect(directSshAuthoritiesEqual(authority, null)).toBe(false)
    expect(directSshAuthoritiesEqual(undefined, authority)).toBe(false)
  })

  it('requires the complete authority tuple', () => {
    expect(directSshAuthoritiesEqual(authority, { ...authority })).toBe(true)
    expect(
      directSshAuthoritiesEqual(authority, {
        ...authority,
        connectionGeneration: authority.connectionGeneration + 1
      })
    ).toBe(false)
  })
})
