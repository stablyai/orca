import { describe, expect, it } from 'vitest'

import {
  normalizeSourceControlAiActionDefaults,
  readSourceControlActionDefault,
  renderSourceControlActionCommandTemplate,
  setSourceControlActionAgentDefault
} from './source-control-ai-actions'
import { resolveSourceControlActionSessionOptions } from './source-control-action-launch-preferences'

describe('source-control AI launch action defaults', () => {
  it('rejects unsafe prototype keys and invalid agent ids', () => {
    expect(
      normalizeSourceControlAiActionDefaults({
        __proto__: { agentId: 'codex' },
        constructor: { agentId: 'codex' },
        prototype: { agentId: 'codex' },
        fixCommitFailure: { agentId: 'not-real', commandInputTemplate: 42 }
      })
    ).toBeUndefined()
  })

  it('trims command templates and CLI args only when reading them', () => {
    const defaults = normalizeSourceControlAiActionDefaults({
      fixCommitFailure: {
        agentId: 'claude',
        commandInputTemplate: '  {basePrompt}  ',
        agentArgs: '  --model sonnet  '
      }
    })

    expect(defaults?.fixCommitFailure?.commandInputTemplate).toBe('  {basePrompt}  ')
    expect(defaults?.fixCommitFailure?.agentArgs).toBe('  --model sonnet  ')
    expect(readSourceControlActionDefault(defaults, 'fixCommitFailure')).toEqual({
      agentId: 'claude',
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model sonnet'
    })
  })

  it('keeps a saved action model and drops a malformed one', () => {
    expect(
      normalizeSourceControlAiActionDefaults({
        fixChecks: {
          agentId: 'codex',
          launchPreferences: { model: ' gpt-5.6-terra ', effort: 'high' }
        },
        resolveConflicts: { agentId: 'claude', launchPreferences: { model: '  ', effort: 'high' } },
        resolveComments: { agentId: 'claude', launchPreferences: 'opus' }
      })
    ).toEqual({
      fixChecks: {
        agentId: 'codex',
        launchPreferences: {
          agentId: 'codex' as const,
          modelSelection: {
            base: 'default',
            model: { agentId: 'codex', value: 'gpt-5.6-terra' },
            options: { effort: { agentId: 'codex', value: 'high' } }
          }
        }
      },
      resolveConflicts: {
        agentId: 'claude',
        launchPreferences: {
          agentId: 'claude',
          modelSelection: {
            base: 'default',
            options: { effort: { agentId: 'claude', value: 'high' } }
          }
        }
      },
      resolveComments: { agentId: 'claude' }
    })
  })

  it('keeps a permission mode the agent offers, with or without a model', () => {
    const defaults = normalizeSourceControlAiActionDefaults({
      fixChecks: { agentId: 'opencode', launchPreferences: { permissionMode: 'full-access' } },
      fixCommitFailure: { agentId: 'codex', launchPreferences: { permissionMode: 'accept-edits' } },
      fixPushFailure: {
        agentId: 'codex',
        launchPreferences: { model: 'gpt-5.6-terra', options: { permissionMode: 'full-access' } }
      }
    })
    expect(defaults).toEqual({
      fixChecks: {
        agentId: 'opencode',
        launchPreferences: { agentId: 'opencode', permissionMode: 'full-access' }
      },
      fixCommitFailure: { agentId: 'codex' },
      fixPushFailure: { agentId: 'codex' }
    })
    expect(resolveSourceControlActionSessionOptions(defaults?.fixChecks ?? {}, 'opencode')).toEqual(
      {
        permissionMode: 'full-access'
      }
    )
  })

  it('drops the saved model when the action changes agent', () => {
    const defaults = {
      fixChecks: {
        agentId: 'codex' as const,
        launchPreferences: { agentId: 'codex' as const, model: 'gpt-5.6-terra' }
      }
    }

    expect(setSourceControlActionAgentDefault(defaults, 'fixChecks', 'codex')).toEqual(defaults)
    expect(setSourceControlActionAgentDefault(defaults, 'fixChecks', 'claude')).toEqual({
      fixChecks: { agentId: 'claude' }
    })
  })

  it('gives the saved model and effort only to the recipe agent', () => {
    const recipe = {
      agentId: 'codex' as const,
      launchPreferences: {
        agentId: 'codex' as const,
        model: 'gpt-5.6-terra',
        options: { effort: 'high' }
      }
    }

    expect(resolveSourceControlActionSessionOptions(recipe, 'codex')).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'high'
    })
    expect(resolveSourceControlActionSessionOptions(recipe, 'claude')).toBeUndefined()
  })

  it('leaves inherited prototype names visible instead of rendering function source', () => {
    expect(
      renderSourceControlActionCommandTemplate('use {constructor} and {toString}', {
        thing: 'CI'
      })
    ).toBe('use {constructor} and {toString}')
  })
})
