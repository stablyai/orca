import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  resolveBranchNameSourceControlAi,
  resolveSourceControlAiForOperation
} from './source-control-ai'
import type { GlobalSettings } from './global-settings-types'

function settingsWithDivergentOperations(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: 'codex',
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium', 'gpt-5.4': 'high', 'gpt-5.4-mini': 'low' },
      customAgentCommand: 'global-agent {prompt}',
      modelOverridesByOperation: {
        commitMessage: { selectedModelByAgent: { codex: 'gpt-5.5' } },
        branchName: { selectedModelByAgent: { codex: 'gpt-5.4' } }
      },
      instructionsByOperation: {
        commitMessage: 'Commit style',
        branchName: 'Rename style'
      }
    }
  }
}

describe('Session History AI search resolution', () => {
  it('matches auto-rename branchName resolution, including repo overrides', () => {
    const settings = settingsWithDivergentOperations()
    const repo = {
      sourceControlAi: {
        customAgentCommand: 'repo-rename-agent {prompt}',
        modelOverridesByOperation: {
          branchName: { selectedModelByAgent: { codex: 'gpt-5.4-mini' } }
        }
      }
    }

    const rename = resolveSourceControlAiForOperation({
      settings,
      repo,
      operation: 'branchName',
      discoveryHostKey: 'local'
    })
    const search = resolveBranchNameSourceControlAi({
      settings,
      repo,
      discoveryHostKey: 'local'
    })
    const commitMessage = resolveSourceControlAiForOperation({
      settings,
      repo,
      operation: 'commitMessage',
      discoveryHostKey: 'local'
    })

    expect(search).toEqual(rename)
    expect(search.ok && search.value.params.model).toBe('gpt-5.4-mini')
    expect(search.ok && search.value.params.customAgentCommand).toBe('repo-rename-agent {prompt}')
    expect(search.ok && search.value.params.customPrompt).toBe('Rename style')
    expect(commitMessage.ok && commitMessage.value.params.model).toBe('gpt-5.5')
    expect(search).not.toEqual(commitMessage)
  })

  it('matches unconfigured rename resolution so search does not invent a second settings path', () => {
    const settings = getDefaultSettings('/tmp')
    settings.sourceControlAi = {
      ...settings.sourceControlAi!,
      agentId: 'custom',
      customAgentCommand: ''
    }

    const rename = resolveSourceControlAiForOperation({
      settings,
      repo: null,
      operation: 'branchName',
      discoveryHostKey: 'local'
    })
    const search = resolveBranchNameSourceControlAi({
      settings,
      repo: null,
      discoveryHostKey: 'local'
    })

    expect(search.ok).toBe(false)
    expect(search).toEqual(rename)
  })
})
