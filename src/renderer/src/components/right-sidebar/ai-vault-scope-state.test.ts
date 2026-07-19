import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_VAULT_SCOPE, normalizeAiVaultScopeForContext } from './ai-vault-scope-state'

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
