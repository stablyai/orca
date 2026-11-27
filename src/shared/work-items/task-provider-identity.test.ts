import { describe, expect, it } from 'vitest'
import {
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart
} from './task-provider-identity'

describe('itsaplan task provider identity', () => {
  it('trims instanceId and projectRef when normalizing', () => {
    expect(
      normalizeTaskProviderIdentity('itsaplan', {
        provider: 'itsaplan',
        instanceId: ' i1 ',
        projectRef: 'acme.ENG'
      })
    ).toEqual({ provider: 'itsaplan', instanceId: 'i1', projectRef: 'acme.ENG' })
  })

  it('joins instanceId and projectRef into the cache part', () => {
    expect(
      taskProviderIdentityCachePart({
        provider: 'itsaplan',
        instanceId: 'i1',
        projectRef: 'acme.ENG'
      })
    ).toBe('i1/acme.ENG')
  })

  it('rejects a stored identity with a non-string projectRef', () => {
    expect(isStoredTaskProviderIdentity('itsaplan', { provider: 'itsaplan', projectRef: 5 })).toBe(
      false
    )
  })
})
