import { describe, expect, it } from 'vitest'
import {
  normalizeAiVaultScopeForContext,
  shouldRestoreAiVaultProjectScope
} from './ai-vault-scope-state'

describe('normalizeAiVaultScopeForContext', () => {
  it('falls back from project to all when no active project is available', () => {
    expect(
      normalizeAiVaultScopeForContext({
        scope: 'project',
        activeProjectKey: null,
        activeWorktreePath: '/repo'
      })
    ).toBe('all')
  })

  it('falls back from workspace to all when no active workspace path is available', () => {
    expect(
      normalizeAiVaultScopeForContext({
        scope: 'workspace',
        activeProjectKey: 'project:orca',
        activeWorktreePath: null
      })
    ).toBe('all')
  })

  it('keeps available project and workspace scopes selected', () => {
    expect(
      normalizeAiVaultScopeForContext({
        scope: 'project',
        activeProjectKey: 'project:orca',
        activeWorktreePath: '/repo'
      })
    ).toBe('project')

    expect(
      normalizeAiVaultScopeForContext({
        scope: 'workspace',
        activeProjectKey: null,
        activeWorktreePath: '/repo'
      })
    ).toBe('workspace')
  })
})

describe('shouldRestoreAiVaultProjectScope', () => {
  it('restores project after automatic fallback when a project becomes available', () => {
    expect(
      shouldRestoreAiVaultProjectScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        userChangedScope: false
      })
    ).toBe(true)
  })

  it('does not restore project after the user manually changed scope', () => {
    expect(
      shouldRestoreAiVaultProjectScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        userChangedScope: true
      })
    ).toBe(false)
  })
})
