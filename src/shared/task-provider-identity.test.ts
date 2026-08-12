import { describe, expect, it } from 'vitest'
import {
  areTaskProviderIdentitiesEqual,
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart
} from './task-provider-identity'

describe('beads task provider identity', () => {
  it('normalizes a beads identity with an optional prefix', () => {
    expect(normalizeTaskProviderIdentity('beads', { provider: 'beads', prefix: ' orca ' })).toEqual(
      { provider: 'beads', prefix: 'orca' }
    )
    expect(normalizeTaskProviderIdentity('beads', { provider: 'beads' })).toEqual({
      provider: 'beads',
      prefix: null
    })
  })

  it('rejects identities whose provider tag does not match', () => {
    expect(normalizeTaskProviderIdentity('beads', { provider: 'jira', prefix: 'orca' })).toBeNull()
    expect(normalizeTaskProviderIdentity('jira', { provider: 'beads', prefix: 'orca' })).toBeNull()
  })

  it('validates stored beads identities', () => {
    expect(isStoredTaskProviderIdentity('beads', { provider: 'beads', prefix: 'orca' })).toBe(true)
    expect(isStoredTaskProviderIdentity('beads', { provider: 'beads', prefix: null })).toBe(true)
    expect(isStoredTaskProviderIdentity('beads', null)).toBe(true)
    expect(isStoredTaskProviderIdentity('beads', { provider: 'beads', prefix: 7 })).toBe(false)
    expect(isStoredTaskProviderIdentity('beads', { provider: 'github', prefix: 'orca' })).toBe(
      false
    )
  })

  it('compares beads identities by prefix, treating null and absent alike', () => {
    expect(
      areTaskProviderIdentitiesEqual(
        { provider: 'beads', prefix: 'orca' },
        { provider: 'beads', prefix: 'orca' }
      )
    ).toBe(true)
    expect(
      areTaskProviderIdentitiesEqual({ provider: 'beads', prefix: null }, {
        provider: 'beads'
      } as never)
    ).toBe(true)
    expect(
      areTaskProviderIdentitiesEqual(
        { provider: 'beads', prefix: 'orca' },
        { provider: 'beads', prefix: 'other' }
      )
    ).toBe(false)
    expect(
      areTaskProviderIdentitiesEqual(
        { provider: 'beads', prefix: 'orca' },
        { provider: 'jira', projectKey: 'orca' }
      )
    ).toBe(false)
  })

  it('uses the prefix as the cache part, empty when unknown', () => {
    expect(taskProviderIdentityCachePart({ provider: 'beads', prefix: 'orca' })).toBe('orca')
    expect(taskProviderIdentityCachePart({ provider: 'beads', prefix: null })).toBe('')
  })
})
