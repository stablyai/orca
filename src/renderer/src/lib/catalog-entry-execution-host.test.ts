import { describe, expect, it } from 'vitest'
import { getCatalogEntryExecutionHostId } from './catalog-entry-execution-host'

describe('getCatalogEntryExecutionHostId', () => {
  it('returns undefined when the entry is missing', () => {
    expect(getCatalogEntryExecutionHostId(undefined)).toBeUndefined()
  })

  it('normalizes a local group to the local host id', () => {
    expect(getCatalogEntryExecutionHostId({ executionHostId: 'local' })).toBe('local')
  })

  it('normalizes a runtime-owned group to its runtime host id', () => {
    expect(getCatalogEntryExecutionHostId({ executionHostId: 'runtime:env-1' })).toBe(
      'runtime:env-1'
    )
  })

  it('defaults an entry with neither field set to the local host id', () => {
    expect(getCatalogEntryExecutionHostId({ executionHostId: null })).toBe('local')
  })

  it('falls back to the SSH host id for a connection-backed entry', () => {
    expect(
      getCatalogEntryExecutionHostId({ executionHostId: null, connectionId: 'ssh-target-1' })
    ).toBe('ssh:ssh-target-1')
  })
})
