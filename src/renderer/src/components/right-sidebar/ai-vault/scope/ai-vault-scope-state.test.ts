import { describe, expect, it } from 'vitest'
import { stepAiVaultScope } from './ai-vault-scope-state'

const both = { workspaceAvailable: true, projectAvailable: true }

describe('stepAiVaultScope', () => {
  it('moves through Workspace, Project, All and wraps', () => {
    expect(stepAiVaultScope({ scope: 'workspace', step: 1, ...both })).toBe('project')
    expect(stepAiVaultScope({ scope: 'project', step: 1, ...both })).toBe('all')
    expect(stepAiVaultScope({ scope: 'all', step: 1, ...both })).toBe('workspace')
    expect(stepAiVaultScope({ scope: 'workspace', step: -1, ...both })).toBe('all')
  })

  it('skips scopes the context cannot show', () => {
    const noWorkspace = { workspaceAvailable: false, projectAvailable: true }
    expect(stepAiVaultScope({ scope: 'all', step: 1, ...noWorkspace })).toBe('project')
    expect(
      stepAiVaultScope({
        scope: 'all',
        step: 1,
        workspaceAvailable: false,
        projectAvailable: false
      })
    ).toBe('all')
  })
})
