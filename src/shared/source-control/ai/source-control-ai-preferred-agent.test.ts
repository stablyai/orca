import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../constants'
import type { GlobalSettings } from '../../global-settings-types'
import { resolveSourceControlAiForOperation } from './source-control-ai-operation-resolution'

function settings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: 'codex',
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium' },
      instructionsByOperation: {
        commitMessage: 'Global commit style',
        pullRequest: 'Global PR style',
        branchName: 'Global branch style'
      }
    }
  }
}

describe('preferred workspace agent for branch rename', () => {
  it('prefers a supported preferredAgentId over the configured SC AI agent', () => {
    const result = resolveSourceControlAiForOperation({
      settings: settings(),
      repo: null,
      operation: 'branchName',
      discoveryHostKey: 'local',
      preferredAgentId: 'claude'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.value.params.agentId).toBe('claude')
    expect(result.value.params.model).toBeTruthy()
  })

  it('ignores preferredAgentId when the agent lacks a generation contract', () => {
    const result = resolveSourceControlAiForOperation({
      settings: settings(),
      repo: null,
      operation: 'branchName',
      discoveryHostKey: 'local',
      preferredAgentId: 'claude-agent-teams'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.value.params.agentId).toBe('codex')
  })
})
