import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings, Repo } from '../../../../shared/types'
import {
  generationParamsToActionRecipe,
  sourceControlTextGenerationDefaultsMatchTarget
} from './source-control-text-generation-defaults'

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

  it('returns false when the repo target has no saved override yet', () => {
    expect(
      sourceControlTextGenerationDefaultsMatchTarget({
        actionId: 'commitMessage',
        target: { type: 'repo', repoId: 'repo-1' },
        params: {
          agentId: 'codex',
          model: 'gpt-5.5',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model sonnet'
        },
        settings: settings(),
        repo: { sourceControlAi: { enabled: true } } satisfies Pick<Repo, 'sourceControlAi'>
      })
    ).toBe(false)
  })

  it('returns true when the current params match the repo saved recipe', () => {
    expect(
      sourceControlTextGenerationDefaultsMatchTarget({
        actionId: 'commitMessage',
        target: { type: 'repo', repoId: 'repo-1' },
        params: {
          agentId: 'opencode',
          model: '',
          commandInputTemplate: '{basePrompt}\n\nrepo only',
          agentArgs: ''
        },
        settings: settings(),
        repo: {
          sourceControlAi: {
            enabled: true,
            actionOverrides: {
              commitMessage: generationParamsToActionRecipe({
                agentId: 'opencode',
                model: '',
                commandInputTemplate: '{basePrompt}\n\nrepo only',
                agentArgs: ''
              })
            }
          }
        } satisfies Pick<Repo, 'sourceControlAi'>
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
