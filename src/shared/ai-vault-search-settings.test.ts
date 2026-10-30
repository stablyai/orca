import { expect, it } from 'vitest'
import {
  AiVaultSearchSettingsSchema,
  resolveAiVaultSearchSettings,
  sameAiVaultSearchSettings
} from './ai-vault-search-settings'

// Default off: indexing reads all machine transcripts and requires recorded opt-in.
it('reads anything that is not an explicit opt-in as off', () => {
  expect(resolveAiVaultSearchSettings(undefined)).toEqual({ enabled: false, historyDays: null })
  expect(resolveAiVaultSearchSettings({})).toEqual({ enabled: false, historyDays: null })
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: null })).toEqual({
    enabled: false,
    historyDays: null
  })
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: 'yes' } })).toEqual({
    enabled: false,
    historyDays: null
  })
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: 'on' })).toEqual({
    enabled: false,
    historyDays: null
  })
})

it('normalizes a history bound and drops anything that is not one', () => {
  expect(
    resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: 30.7 } })
  ).toEqual({ enabled: true, historyDays: 30 })
  // Fractional days floor to zero, otherwise disagreeing as all-history versus cutoff-now.
  for (const historyDays of [0.4, 0, -30, Number.NaN] as const) {
    expect(resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays } })).toEqual(
      { enabled: true, historyDays: null }
    )
  }
  expect(
    resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: 999_999 } })
  ).toEqual({ enabled: true, historyDays: 3_650 })
})

// No paused lifecycle: immutable indexers would otherwise need a second store/queue/sweep lifetime.
it('keeps only the two fields the indexer is constructed from', () => {
  expect(
    resolveAiVaultSearchSettings({
      aiVaultSearch: { enabled: true, historyDays: 90, paused: true }
    })
  ).toEqual({ enabled: true, historyDays: 90 })
})

it('accepts what it produces and refuses what it does not', () => {
  expect(AiVaultSearchSettingsSchema.parse({ enabled: true, historyDays: 90 })).toEqual({
    enabled: true,
    historyDays: 90
  })
  expect(AiVaultSearchSettingsSchema.safeParse({ enabled: true, historyDays: 0 }).success).toBe(
    false
  )
  expect(AiVaultSearchSettingsSchema.safeParse({ historyDays: null }).success).toBe(false)
})

it('compares both enabled state and history bounds', () => {
  expect(
    sameAiVaultSearchSettings(
      { enabled: true, historyDays: 30 },
      { enabled: true, historyDays: 30 }
    )
  ).toBe(true)
  expect(
    sameAiVaultSearchSettings(
      { enabled: true, historyDays: 30 },
      { enabled: true, historyDays: 90 }
    )
  ).toBe(false)
  expect(
    sameAiVaultSearchSettings(
      { enabled: true, historyDays: null },
      { enabled: false, historyDays: null }
    )
  ).toBe(false)
})
