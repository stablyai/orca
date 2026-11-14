import { describe, expect, it } from 'vitest'
import { normalizeAiVaultViewOptions } from './ai-vault-view-options-persistence'

describe('normalizeAiVaultViewOptions', () => {
  it('defaults Sessions per group to All for options saved before the setting existed', () => {
    const legacy = { disabledAgents: [], sort: 'created', group: 'project', sessionLimit: 500 }

    expect(normalizeAiVaultViewOptions(legacy).groupSessionLimit).toBe('all')
    for (const limit of [3, 5, 10, 'all'] as const) {
      expect(normalizeAiVaultViewOptions({ groupSessionLimit: limit }).groupSessionLimit).toBe(
        limit
      )
    }
    for (const invalid of [0, -3, 4, '5', 'unlimited', null]) {
      expect(normalizeAiVaultViewOptions({ groupSessionLimit: invalid }).groupSessionLimit).toBe(
        'all'
      )
    }
  })
})
