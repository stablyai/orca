import { describe, expect, it } from 'vitest'
import {
  normalizeSourceControlAiActionDefaults,
  readSourceControlActionDefault,
  renderSourceControlActionCommandTemplate,
  resolveSourceControlActionCommandTemplate,
  setSourceControlActionAgentDefault
} from './source-control-ai-actions'

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
        pullRequest: { agentId: 'claude' }
      })
    ).toEqual({
      fixChecks: {
        agentId: 'codex',
        commandInputTemplate: '  {basePrompt}  ',
        agentArgs: '  --model gpt-5.5  '
      },
      resolveConflicts: { agentId: null },
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
