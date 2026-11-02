import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  normalizeSourceControlAiActionDefaults,
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_TEXT_ACTION_IDS
} from './source-control-ai-actions'
import { normalizeSourceControlAiSettings } from './source-control-ai-settings'
import { resolveSourceControlAiForOperation } from './source-control-ai'

describe('conversation name action', () => {
  it('retains a saved recipe while Git action lists remain Git-only', () => {
    const recipe = { agentId: 'codex', commandInputTemplate: 'Name {firstPrompt}' }
    expect(normalizeSourceControlAiActionDefaults({ conversationName: recipe })).toEqual({
      conversationName: recipe
    })
    expect(normalizeSourceControlAiSettings(undefined).actions?.conversationName).toEqual({
      commandInputTemplate: '{basePrompt}'
    })
    expect(SOURCE_CONTROL_ACTION_IDS).not.toContain('conversationName')
    expect(SOURCE_CONTROL_TEXT_ACTION_IDS).not.toContain('conversationName')
  })

  it('ignores repository overrides for chat names but applies global model and recipe', () => {
    const settings = getDefaultSettings('/tmp')
    settings.defaultTuiAgent = 'codex'
    settings.sourceControlAi = {
      ...settings.sourceControlAi!,
      enabled: false,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.5' },
      actions: {
        ...settings.sourceControlAi?.actions,
        conversationName: { commandInputTemplate: '{firstPrompt}', agentArgs: '--model gpt-5.4' }
      }
    }
    const result = resolveSourceControlAiForOperation({
      settings,
      operation: 'conversationName',
      repo: {
        sourceControlAi: {
          customAgentCommand: 'repo-agent',
          enabled: false,
          modelOverridesByOperation: { branchName: { selectedModelByAgent: { codex: 'gpt-5.4' } } }
        }
      }
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        params: {
          agentId: 'codex',
          model: 'gpt-5.5',
          commandInputTemplate: '{firstPrompt}',
          agentArgs: '--model gpt-5.4'
        }
      }
    })
    expect(result.ok && result.value.params.customAgentCommand).toBeUndefined()
  })

  it('directs chat agent configuration failures to Chat names', () => {
    const settings = getDefaultSettings('/tmp')
    settings.sourceControlAi = {
      ...settings.sourceControlAi!,
      actions: { ...settings.sourceControlAi?.actions, conversationName: { agentId: 'custom' } },
      customAgentCommand: ''
    }
    const result = resolveSourceControlAiForOperation({ settings, operation: 'conversationName' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Settings -> Chat -> Chat names')
    }
  })
})
