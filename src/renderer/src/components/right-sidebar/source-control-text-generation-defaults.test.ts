import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { sourceControlTextGenerationDefaultsMatchTarget } from './source-control/ai/text-generation-defaults'

function settings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      actions: {
        commitMessage: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model sonnet'
        }
      }
    }
  }
}

describe('sourceControlTextGenerationDefaultsMatchTarget', () => {
  it('returns true when the current params match the global saved recipe', () => {
    const currentSettings = settings()
    expect(
      sourceControlTextGenerationDefaultsMatchTarget({
        actionId: 'commitMessage',
        target: { type: 'global' },
        params: {
          agentId: 'codex',
          model: 'gpt-5.5',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model sonnet'
        },
        settings: currentSettings
      })
    ).toBe(true)
  })

  it('returns false when the command template differs from the saved recipe', () => {
    expect(
      sourceControlTextGenerationDefaultsMatchTarget({
        actionId: 'commitMessage',
        target: { type: 'global' },
        params: {
          agentId: 'codex',
          model: 'gpt-5.5',
          commandInputTemplate: '{basePrompt}\n\nchanged',
          agentArgs: '--model sonnet'
        },
        settings: settings()
      })
    ).toBe(false)
  })
})
