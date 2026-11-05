import { describe, expect, it } from 'vitest'
import {
  MAX_SOURCE_CONTROL_CUSTOM_ACTIONS,
  MAX_SOURCE_CONTROL_CUSTOM_ACTION_LABEL_LENGTH,
  MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH,
  normalizeSourceControlCustomActions,
  renderPullRequestCustomActionPrompt,
  SOURCE_CONTROL_CUSTOM_ACTION_EXAMPLE_TEMPLATE
} from './source-control-custom-actions'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from './source-control-ai-settings'

const pullRequest = {
  url: 'https://github.com/acme/api/pull/123',
  number: 123,
  title: 'Add retry to the upload client',
  branchName: 'feature/upload-retry',
  baseRefName: 'main'
}

describe('normalizeSourceControlCustomActions', () => {
  it('returns undefined when the value is not a list', () => {
    expect(normalizeSourceControlCustomActions(undefined)).toBeUndefined()
    expect(normalizeSourceControlCustomActions({ id: 'a' })).toBeUndefined()
  })

  it('trims fields and keeps the agent and CLI arguments', () => {
    expect(
      normalizeSourceControlCustomActions([
        {
          id: ' review ',
          label: ' Review ',
          commandInputTemplate: ' /code-review {prUrl} ',
          agentId: 'claude',
          agentArgs: ' --model opus '
        }
      ])
    ).toEqual([
      {
        id: 'review',
        label: 'Review',
        commandInputTemplate: '/code-review {prUrl}',
        agentId: 'claude',
        agentArgs: '--model opus'
      }
    ])
  })

  it('drops entries without an id, label, or prompt', () => {
    expect(
      normalizeSourceControlCustomActions([
        { label: 'No id', commandInputTemplate: 'x' },
        { id: 'no-label', label: '  ', commandInputTemplate: 'x' },
        { id: 'no-prompt', label: 'No prompt', commandInputTemplate: '' },
        'not an object',
        null
      ])
    ).toBeUndefined()
  })

  it('drops entries whose label or prompt exceeds the limits', () => {
    const actions = normalizeSourceControlCustomActions([
      {
        id: 'long-label',
        label: 'x'.repeat(MAX_SOURCE_CONTROL_CUSTOM_ACTION_LABEL_LENGTH + 1),
        commandInputTemplate: 'x'
      },
      {
        id: 'long-prompt',
        label: 'Long prompt',
        commandInputTemplate: 'x'.repeat(MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH + 1)
      },
      { id: 'ok', label: 'OK', commandInputTemplate: 'x' }
    ])
    expect(actions?.map((action) => action.id)).toEqual(['ok'])
  })

  it('keeps the first entry when ids repeat', () => {
    const actions = normalizeSourceControlCustomActions([
      { id: 'a', label: 'First', commandInputTemplate: 'x' },
      { id: 'a', label: 'Second', commandInputTemplate: 'y' }
    ])
    expect(actions?.map((action) => action.label)).toEqual(['First'])
  })

  it('caps the list at the maximum number of actions', () => {
    const actions = normalizeSourceControlCustomActions(
      Array.from({ length: MAX_SOURCE_CONTROL_CUSTOM_ACTIONS + 5 }, (_, index) => ({
        id: `action-${index}`,
        label: `Action ${index}`,
        commandInputTemplate: 'x'
      }))
    )
    expect(actions).toHaveLength(MAX_SOURCE_CONTROL_CUSTOM_ACTIONS)
  })

  it('drops agents a workspace launch cannot start', () => {
    const [unknownAgent, customCommand, defaultAgent] =
      normalizeSourceControlCustomActions([
        { id: 'unknown', label: 'Unknown', commandInputTemplate: 'x', agentId: 'not-an-agent' },
        { id: 'custom', label: 'Custom', commandInputTemplate: 'x', agentId: 'custom' },
        { id: 'default', label: 'Default', commandInputTemplate: 'x', agentId: null }
      ]) ?? []
    expect(unknownAgent).not.toHaveProperty('agentId')
    expect(customCommand).not.toHaveProperty('agentId')
    expect(defaultAgent?.agentId).toBeNull()
  })
})

describe('renderPullRequestCustomActionPrompt', () => {
  it('fills the documented example with the pull request URL', () => {
    expect(
      renderPullRequestCustomActionPrompt(
        { commandInputTemplate: SOURCE_CONTROL_CUSTOM_ACTION_EXAMPLE_TEMPLATE },
        pullRequest
      )
    ).toBe('/code-review https://github.com/acme/api/pull/123 xhigh --comment with codex.')
  })

  it('fills every pull request variable', () => {
    expect(
      renderPullRequestCustomActionPrompt(
        { commandInputTemplate: '#{prNumber} {prTitle} {headBranch} -> {{ baseBranch }}' },
        pullRequest
      )
    ).toBe('#123 Add retry to the upload client feature/upload-retry -> main')
  })

  it('renders unknown branches as empty and leaves unknown variables visible', () => {
    expect(
      renderPullRequestCustomActionPrompt(
        { commandInputTemplate: 'review {headBranch} {basePrompt}' },
        { ...pullRequest, branchName: undefined }
      )
    ).toBe('review  {basePrompt}')
  })
})

describe('normalizeSourceControlAiSettings custom actions', () => {
  it('normalizes saved custom actions', () => {
    const settings = normalizeSourceControlAiSettings({
      ...getDefaultSourceControlAiSettings(),
      customActions: [
        { id: 'review', label: ' Review ', commandInputTemplate: '/code-review {prUrl}' },
        { id: '', label: 'Broken', commandInputTemplate: 'x' }
      ]
    })
    expect(settings.customActions).toEqual([
      { id: 'review', label: 'Review', commandInputTemplate: '/code-review {prUrl}' }
    ])
  })

  it('does not add the key to settings that never had custom actions', () => {
    const settings = normalizeSourceControlAiSettings(getDefaultSourceControlAiSettings())
    expect(Object.hasOwn(settings, 'customActions')).toBe(false)
  })
})
