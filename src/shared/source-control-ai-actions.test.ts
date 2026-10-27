import { describe, expect, it } from 'vitest'
import { SOURCE_CONTROL_ACTION_VARIABLES } from './source-control-ai-action-variables'
import {
  normalizeSourceControlAiActionDefaults,
  SOURCE_CONTROL_LAUNCH_ACTION_IDS,
  SOURCE_CONTROL_LAUNCH_ACTION_LABELS,
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  readSourceControlActionDefault,
  renderSourceControlActionCommandTemplate,
  resolveSourceControlActionCommandTemplate,
  setSourceControlActionAgentDefault
} from './source-control-ai-actions'
import { resolveSourceControlActionSessionOptions } from './source-control-action-launch-preferences'

describe('source-control AI launch action defaults', () => {
  it('normalizes safe launch action defaults', () => {
    expect(
      normalizeSourceControlAiActionDefaults({
        fixChecks: {
          agentId: 'codex',
          commandInputTemplate: '  {basePrompt}  ',
          agentArgs: '  --model gpt-5.5  '
        },
        resolveConflicts: { agentId: null },
        resolveComments: {
          commandInputTemplate: 'Resolve {basePrompt}'
        },
        pullRequest: { agentId: 'claude' }
      })
    ).toEqual({
      fixChecks: {
        agentId: 'codex',
        commandInputTemplate: '  {basePrompt}  ',
        agentArgs: '  --model gpt-5.5  '
      },
      resolveConflicts: { agentId: null },
      resolveComments: {
        commandInputTemplate: 'Resolve {basePrompt}'
      },
      pullRequest: { agentId: 'claude' }
    })
  })

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

  it('normalizes the custom command sentinel for text action recipes', () => {
    expect(
      normalizeSourceControlAiActionDefaults({
        pullRequest: {
          agentId: 'custom',
          commandInputTemplate: '{basePrompt}'
        }
      })
    ).toEqual({
      pullRequest: {
        agentId: 'custom',
        commandInputTemplate: '{basePrompt}'
      }
    })
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

  it('preserves explicitly empty command templates when resolving defaults', () => {
    expect(
      resolveSourceControlActionCommandTemplate(
        { fixCommitFailure: { commandInputTemplate: '' } },
        'fixCommitFailure'
      )
    ).toBe('')
    expect(resolveSourceControlActionCommandTemplate(undefined, 'fixCommitFailure')).toBe(
      '{basePrompt}'
    )
  })

  it('renders command template placeholders that start with underscores', () => {
    expect(
      renderSourceControlActionCommandTemplate('agent {_prompt} {{_context}}', {
        _prompt: 'PROMPT',
        _context: 'CONTEXT'
      })
    ).toBe('agent PROMPT CONTEXT')
  })

  it('sets agent defaults without dropping neighboring action defaults', () => {
    expect(
      setSourceControlActionAgentDefault(
        { fixChecks: { agentId: 'codex' } },
        'resolveConflicts',
        'claude'
      )
    ).toEqual({
      fixChecks: { agentId: 'codex' },
      resolveConflicts: { agentId: 'claude' }
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
          model: 'gpt-5.6-terra',
          options: { effort: 'high' }
        }
      },
      resolveConflicts: { agentId: 'claude' },
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

  it('exposes review-comment resolution as a launch action', () => {
    expect(SOURCE_CONTROL_LAUNCH_ACTION_IDS).toContain('resolveComments')
    expect(SOURCE_CONTROL_LAUNCH_ACTION_LABELS.resolveComments).toBe('Review comment resolution')
    expect(resolveSourceControlActionCommandTemplate(undefined, 'resolveComments')).toBe(
      '{basePrompt}'
    )
    expect(SOURCE_CONTROL_ACTION_VARIABLES.resolveComments).toEqual(['basePrompt'])
  })

  it('exposes push failure recovery as a launch action with basePrompt defaults', () => {
    expect(SOURCE_CONTROL_LAUNCH_ACTION_IDS).toContain('fixPushFailure')
    expect(SOURCE_CONTROL_LAUNCH_ACTION_LABELS.fixPushFailure).toBe('Push failure fixes')
    expect(DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixPushFailure).toBe('{basePrompt}')
    expect(resolveSourceControlActionCommandTemplate(undefined, 'fixPushFailure')).toBe(
      '{basePrompt}'
    )
    expect(SOURCE_CONTROL_ACTION_VARIABLES.fixPushFailure).toEqual(['basePrompt'])
    expect(
      normalizeSourceControlAiActionDefaults({
        fixPushFailure: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model gpt-5.4-mini'
        }
      })
    ).toEqual({
      fixPushFailure: {
        agentId: 'codex',
        commandInputTemplate: '{basePrompt}',
        agentArgs: '--model gpt-5.4-mini'
      }
    })
  })

  it('renders known template variables and leaves unknown variables visible', () => {
    expect(
      renderSourceControlActionCommandTemplate('fix {thing} with {missing}', {
        thing: 'CI'
      })
    ).toBe('fix CI with {missing}')
  })

  it('leaves inherited prototype names visible instead of rendering function source', () => {
    expect(
      renderSourceControlActionCommandTemplate('use {constructor} and {toString}', {
        thing: 'CI'
      })
    ).toBe('use {constructor} and {toString}')
  })
})
