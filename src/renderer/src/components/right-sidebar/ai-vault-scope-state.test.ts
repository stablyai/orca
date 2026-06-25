import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AI_VAULT_SCOPE,
  getRestorableAiVaultScope,
  normalizeAiVaultScopeForContext,
  shouldRestoreDefaultAiVaultScope
} from './ai-vault-scope-state'

describe('DEFAULT_AI_VAULT_SCOPE', () => {
  it('defaults the session history scope to workspace', () => {
    expect(DEFAULT_AI_VAULT_SCOPE).toBe('workspace')
  })
})

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

describe('shouldRestoreDefaultAiVaultScope', () => {
  it('restores workspace after automatic fallback when a workspace becomes available', () => {
    expect(
      shouldRestoreDefaultAiVaultScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        activeWorktreePath: '/repo',
        userChangedScope: false
      })
    ).toBe(true)
  })

  it('does not restore workspace while the workspace is unavailable', () => {
    expect(
      shouldRestoreDefaultAiVaultScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        activeWorktreePath: null,
        userChangedScope: false
      })
    ).toBe(false)
  })

  it('does not restore workspace after the user manually chose project or all', () => {
    expect(
      shouldRestoreDefaultAiVaultScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        activeWorktreePath: '/repo',
        userChangedScope: true
      })
    ).toBe(false)
  })

  it('can restore a project default only when a project becomes available', () => {
    expect(
      shouldRestoreDefaultAiVaultScope({
        scope: 'all',
        activeProjectKey: null,
        activeWorktreePath: '/repo',
        userChangedScope: false,
        defaultScope: 'project'
      })
    ).toBe(false)

    expect(
      shouldRestoreDefaultAiVaultScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        activeWorktreePath: '/repo',
        userChangedScope: false,
        defaultScope: 'project'
      })
    ).toBe(true)
  })
})

describe('getRestorableAiVaultScope', () => {
  it('restores the workspace preference after automatic fallback', () => {
    expect(
      getRestorableAiVaultScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        activeWorktreePath: '/repo',
        preferredScope: 'workspace',
        userChangedScope: false
      })
    ).toBe('workspace')
  })

  it('restores a manual project preference when a project becomes available again', () => {
    expect(
      getRestorableAiVaultScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        activeWorktreePath: '/repo',
        preferredScope: 'project',
        userChangedScope: true
      })
    ).toBe('project')
  })

  it('keeps a manual all preference sticky', () => {
    expect(
      getRestorableAiVaultScope({
        scope: 'all',
        activeProjectKey: 'project:orca',
        activeWorktreePath: '/repo',
        preferredScope: 'all',
        userChangedScope: true
      })
    ).toBeNull()
  })
})
