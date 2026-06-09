import { describe, expect, it } from 'vitest'
import { buildCommitMessageGenerationParams } from './SourceControlTextGenerationDialog'
import {
  applyCommitMessageGenerationDefaults,
  applySourceControlTextGenerationDefaults
} from './SourceControlTextGenerationDefaults'

describe('buildCommitMessageGenerationParams', () => {
  it('preserves the resolved model and thinking level for the selected agent', () => {
    expect(
      buildCommitMessageGenerationParams({
        agentId: 'codex',
        commandTemplate: '{basePrompt}\n\nUse Conventional Commits.',
        agentArgs: '--model gpt-5.5',
        baseParams: {
          agentId: 'codex',
          model: 'gpt-5.4-mini',
          thinkingLevel: 'xhigh',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model gpt-5.5',
          agentCommandOverride: 'codex'
        },
        settings: { agentCmdOverrides: { codex: 'codex --profile work' } }
      })
    ).toEqual({
      agentId: 'codex',
      model: 'gpt-5.4-mini',
      thinkingLevel: 'xhigh',
      commandInputTemplate: '{basePrompt}\n\nUse Conventional Commits.',
      agentArgs: '--model gpt-5.5',
      agentCommandOverride: 'codex --profile work'
    })
  })

  it('keeps existing custom-command generation usable from the dialog', () => {
    expect(
      buildCommitMessageGenerationParams({
        agentId: 'custom',
        commandTemplate: '{basePrompt}\n\nPrefer ticket IDs.',
        baseParams: {
          agentId: 'custom',
          model: '',
          customPrompt: 'Prefer ticket IDs.',
          commandInputTemplate: '{basePrompt}\n\nPrefer ticket IDs.',
          customAgentCommand: 'my-commit-writer --prompt {prompt}'
        },
        settings: null
      })
    ).toEqual({
      agentId: 'custom',
      model: '',
      customPrompt: 'Prefer ticket IDs.',
      commandInputTemplate: '{basePrompt}\n\nPrefer ticket IDs.',
      customAgentCommand: 'my-commit-writer --prompt {prompt}'
    })
  })

  it('uses the configured custom command when switching agents in the dialog', () => {
    expect(
      buildCommitMessageGenerationParams({
        agentId: 'custom',
        commandTemplate: '{basePrompt}',
        baseParams: {
          agentId: 'codex',
          model: 'gpt-5.4-mini',
          commandInputTemplate: '{basePrompt}'
        },
        settings: null,
        customAgentCommand: 'my-commit-writer --prompt {prompt}'
      })
    ).toEqual({
      agentId: 'custom',
      model: '',
      customPrompt: undefined,
      commandInputTemplate: '{basePrompt}',
      customAgentCommand: 'my-commit-writer --prompt {prompt}'
    })
  })

  it('saves custom-command templates as an explicit action recipe', () => {
    const saved = applyCommitMessageGenerationDefaults(
      {
        enabled: true,
        agentId: 'custom',
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        customAgentCommand: 'my-commit-writer',
        instructionsByOperation: {},
        actions: {
          commitMessage: {
            agentId: 'codex',
            commandInputTemplate: '{basePrompt}'
          }
        }
      },
      'local',
      {
        agentId: 'custom',
        model: '',
        commandInputTemplate: '{basePrompt}\n\nPrefer ticket IDs.',
        customAgentCommand: 'my-commit-writer'
      }
    )

    expect(saved.agentId).toBe('custom')
    expect(saved.actions?.commitMessage).toEqual({
      agentId: 'custom',
      commandInputTemplate: '{basePrompt}\n\nPrefer ticket IDs.'
    })
  })

  it('saves a custom default without changing unrelated text actions', () => {
    const saved = applySourceControlTextGenerationDefaults(
      {
        enabled: true,
        agentId: 'codex',
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        customAgentCommand: 'my-commit-writer',
        instructionsByOperation: {},
        actions: {
          pullRequest: {
            agentId: 'codex',
            commandInputTemplate: '{basePrompt}'
          }
        }
      },
      'pullRequest',
      {
        agentId: 'custom',
        model: '',
        commandInputTemplate: '{basePrompt}\n\nPrefer ticket IDs.',
        customAgentCommand: 'my-commit-writer'
      }
    )

    expect(saved.agentId).toBe('codex')
    expect(saved.actions?.pullRequest).toEqual({
      agentId: 'custom',
      commandInputTemplate: '{basePrompt}\n\nPrefer ticket IDs.'
    })
  })

  it('saves the selected agent and command template as the commit-message recipe', () => {
    expect(
      applyCommitMessageGenerationDefaults(
        {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customAgentCommand: '',
          instructionsByOperation: {},
          actions: {
            commitMessage: {
              commandInputTemplate: '{basePrompt}'
            }
          }
        },
        'local',
        {
          agentId: 'codex',
          model: 'gpt-5.4-mini',
          commandInputTemplate: 'just use "{branch}"'
        }
      ).actions?.commitMessage
    ).toEqual({
      agentId: 'codex',
      commandInputTemplate: 'just use "{branch}"'
    })
  })

  it('saves pull-request text generation defaults through the shared dialog helper', () => {
    expect(
      applySourceControlTextGenerationDefaults(
        {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customAgentCommand: '',
          instructionsByOperation: {},
          actions: {
            pullRequest: {
              commandInputTemplate: '{basePrompt}'
            }
          }
        },
        'pullRequest',
        {
          agentId: 'codex',
          model: 'gpt-5.4-mini',
          commandInputTemplate: '{basePrompt}\n\nKeep it short.',
          agentArgs: '--model gpt-5.5'
        }
      ).actions?.pullRequest
    ).toEqual({
      agentId: 'codex',
      commandInputTemplate: '{basePrompt}\n\nKeep it short.',
      agentArgs: '--model gpt-5.5'
    })
  })
})
