import { describe, expect, it } from 'vitest'
import {
  codexUsageAccountFilterValue,
  findCodexUsageAccountOption,
  missingCodexUsageAccountOption,
  parseCodexUsageAccountFilter,
  resolveCodexUsageAccountOption,
  shortCodexUsageAccountId
} from './codex-usage-account-filter'

describe('Codex usage account filter', () => {
  it('round-trips managed, system, and unattributed selections', () => {
    for (const filter of [
      { kind: 'managed' as const, accountId: 'account-a' },
      { kind: 'system' as const },
      { kind: 'unattributed' as const },
      { kind: 'all' as const }
    ]) {
      expect(parseCodexUsageAccountFilter(codexUsageAccountFilterValue(filter))).toEqual(filter)
    }
  })

  it('rejects malformed managed selections', () => {
    expect(parseCodexUsageAccountFilter('managed:')).toBeNull()
    expect(parseCodexUsageAccountFilter('other')).toBeNull()
  })

  it('finds a removed account option and formats a bounded id', () => {
    const option = {
      kind: 'managed' as const,
      accountId: '12345678-abcd',
      workspaceLabel: null,
      deleted: true
    }
    expect(
      findCodexUsageAccountOption([option], {
        kind: 'managed',
        accountId: '12345678-abcd'
      })
    ).toEqual(option)
    expect(shortCodexUsageAccountId(option.accountId)).toBe('12345678')
  })

  it('synthesizes a deleted option when the selected managed account is gone', () => {
    const filter = { kind: 'managed' as const, accountId: 'missing-account' }
    expect(missingCodexUsageAccountOption([], filter)).toEqual({
      kind: 'managed',
      accountId: 'missing-account',
      workspaceLabel: null,
      deleted: true
    })
    expect(resolveCodexUsageAccountOption([], filter)).toEqual({
      kind: 'managed',
      accountId: 'missing-account',
      workspaceLabel: null,
      deleted: true
    })
  })

  it('does not synthesize an option when the selected account is still listed', () => {
    const option = {
      kind: 'managed' as const,
      accountId: 'account-a',
      workspaceLabel: 'Work',
      deleted: false
    }
    const filter = { kind: 'managed' as const, accountId: 'account-a' }
    expect(missingCodexUsageAccountOption([option], filter)).toBeNull()
    expect(resolveCodexUsageAccountOption([option], filter)).toEqual(option)
  })
})
