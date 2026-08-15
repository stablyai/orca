import { describe, expect, it } from 'vitest'
import { parseCodexUsageAccountFilterArg } from './codex-usage-account-filter-contract'

describe('Codex usage account filter contract', () => {
  it('accepts bounded canonical filters', () => {
    expect(parseCodexUsageAccountFilterArg({ kind: 'all' })).toEqual({ kind: 'all' })
    expect(parseCodexUsageAccountFilterArg({ kind: 'managed', accountId: ' account-a ' })).toEqual({
      kind: 'managed',
      accountId: 'account-a'
    })
  })

  it('rejects malformed and oversized account ids', () => {
    expect(parseCodexUsageAccountFilterArg({ kind: 'managed', accountId: '' })).toBeNull()
    expect(
      parseCodexUsageAccountFilterArg({ kind: 'managed', accountId: 'x'.repeat(513) })
    ).toBeNull()
    expect(parseCodexUsageAccountFilterArg({ kind: 'other' })).toBeNull()
  })
})
