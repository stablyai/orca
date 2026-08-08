import { describe, expect, it } from 'vitest'
import {
  codexUsageAccountFilterValue,
  findCodexUsageAccountOption,
  parseCodexUsageAccountFilter,
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
})
