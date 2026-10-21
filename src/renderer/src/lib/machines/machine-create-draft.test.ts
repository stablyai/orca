import { describe, expect, it } from 'vitest'
import {
  createMachineDraft,
  getDraftExpiry,
  getMachineTtlChoices,
  resolveMachineName
} from './machine-create-draft'

const PROVIDER = 'plugin:omarchy/omarchy' as const

describe('machine create draft', () => {
  it('defaults to Temporary with the provider’s TTL and image', () => {
    const draft = createMachineDraft(PROVIDER, {
      verbs: ['create'],
      lifetimes: ['persistent', 'temporary'],
      defaultTtlSeconds: 7200,
      maxTtlSeconds: 86400,
      defaultImage: 'debian'
    })
    expect(draft).toEqual({
      providerKey: PROVIDER,
      lifetime: 'temporary',
      ttlSeconds: 7200,
      image: 'debian',
      name: ''
    })
  })

  it('falls back to Persistent when the provider has no Temporary machines', () => {
    const draft = createMachineDraft(PROVIDER, { verbs: ['create'], lifetimes: ['persistent'] })
    expect(draft.lifetime).toBe('persistent')
    expect(draft.ttlSeconds).toBeNull()
  })

  it('never offers a duration past the provider’s cap', () => {
    expect(
      getMachineTtlChoices({ verbs: [], lifetimes: ['temporary'], maxTtlSeconds: 5 * 3600 })
    ).toEqual([3600, 7200, 14400])
    expect(
      getMachineTtlChoices({ verbs: [], lifetimes: ['temporary'], maxTtlSeconds: 1800 })
    ).toEqual([1800])
  })

  it('computes the expiry only for Temporary machines', () => {
    const draft = createMachineDraft(PROVIDER, {
      verbs: ['create'],
      lifetimes: ['temporary'],
      defaultTtlSeconds: 3600
    })
    expect(getDraftExpiry(draft, 1_000)).toBe(3_601_000)
    expect(getDraftExpiry({ ...draft, lifetime: 'persistent' }, 1_000)).toBeNull()
  })

  it('names the machine after the worktree unless edited', () => {
    const draft = createMachineDraft(PROVIDER, undefined)
    const suffix = (): string => 'abc123xyz'
    expect(resolveMachineName(draft, 'fix-auth', suffix)).toBe('fix-auth')
    expect(resolveMachineName({ ...draft, name: ' box ' }, 'fix-auth', suffix)).toBe('box')
    expect(resolveMachineName(draft, 'feat/über auth', suffix)).toBe('feat-uber-auth')
    expect(resolveMachineName(draft, '-x.', suffix)).toBe('x')
    expect(resolveMachineName(draft, '..', suffix)).toBe('machine-abc123')
    expect(resolveMachineName(draft, '', suffix)).toBe('machine-abc123')
    expect(resolveMachineName(draft, 'x'.repeat(80), suffix)).toHaveLength(63)
  })
})
