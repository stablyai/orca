import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { aiVaultTitleSyncInputsChanged } from './ai-vault-tab-title-sync-inputs'

describe('aiVaultTitleSyncInputsChanged', () => {
  it('distinguishes an absent Vault title from an explicit clear', () => {
    const previous = createTestStore().getState()
    const tab = makeTab({ id: 'terminal-1', worktreeId: 'wt-1' })
    const withAbsent = {
      ...previous,
      tabsByWorktree: { 'wt-1': [tab] }
    }
    const withClear = {
      ...withAbsent,
      tabsByWorktree: { 'wt-1': [{ ...tab, aiVaultTitle: null }] }
    }

    expect(aiVaultTitleSyncInputsChanged(withClear, withAbsent)).toBe(true)
    expect(aiVaultTitleSyncInputsChanged(withClear, withClear)).toBe(false)
  })
})
