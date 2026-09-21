import { expect, it } from 'vitest'
import {
  AiVaultSearchSettingsSchema,
  DEFAULT_AI_VAULT_SEARCH_SETTINGS,
  resolveAiVaultSearchSettings,
  sameAiVaultSearchSettings
} from './ai-vault-search-settings'

// Off is the only safe default: building the index reads every transcript on the
// machine, so a profile that has never answered must read as "no".
it('reads anything that is not an explicit opt-in as off', () => {
  expect(resolveAiVaultSearchSettings(undefined)).toEqual(DEFAULT_AI_VAULT_SEARCH_SETTINGS)
  expect(resolveAiVaultSearchSettings({})).toEqual(DEFAULT_AI_VAULT_SEARCH_SETTINGS)
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: null })).toEqual(
    DEFAULT_AI_VAULT_SEARCH_SETTINGS
  )
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: 'yes' } })).toEqual(
    DEFAULT_AI_VAULT_SEARCH_SETTINGS
  )
  expect(resolveAiVaultSearchSettings({ aiVaultSearch: 'on' })).toEqual(
    DEFAULT_AI_VAULT_SEARCH_SETTINGS
  )
})

it('normalizes a history bound and drops anything that is not one', () => {
  expect(
    resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: 30.7 } })
  ).toEqual({ enabled: true, historyDays: 30 })
  // A fractional day floors to zero, which would read as "all history" on one
  // side and "cutoff is now" on the other.
  for (const historyDays of [0.4, 0, -30, Number.NaN] as const) {
    expect(resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays } })).toEqual(
      { enabled: true, historyDays: null }
    )
  }
  expect(
    resolveAiVaultSearchSettings({ aiVaultSearch: { enabled: true, historyDays: 999_999 } })
  ).toEqual({ enabled: true, historyDays: 3_650 })
})

// There is no `paused`: the indexer is immutable, so a pause would be a second
// lifetime for one object's store, queue and sweep flag.
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

it('treats an unchanged policy as unchanged so a re-save never restarts the index', () => {
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
