import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  normalizeWritableRepoSourceControlAiOverrides,
  saveSourceControlActionRecipe,
  toSourceControlAiRepoUpdate
} from './source-control-ai-recipe-save'
import type { GlobalSettings, Repo } from './types'

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
      selectedThinkingByModel: {}
    }
  }
}

describe('source-control AI recipe saves', () => {
  it('writes complete repo recipes and removes same-action legacy instructions', () => {
    const result = saveSourceControlActionRecipe({
      target: { type: 'repo', repoId: 'repo-1' },
      settings: settings(),
      repo: {
        sourceControlAi: {
          enabled: false,
          instructionsByOperation: {
            commitMessage: 'legacy commit',
            pullRequest: 'legacy review'
          },
          prCreationDefaults: {
            draft: true,
            useTemplate: null
          }
        }
      } satisfies Pick<Repo, 'sourceControlAi'>,
      actionId: 'commitMessage',
      recipe: {
        agentId: 'claude',
        commandInputTemplate: '{basePrompt}\n\nrepo',
        agentArgs: '  --model sonnet  '
      }
    })

    expect(result).toEqual({
      target: { type: 'repo', repoId: 'repo-1' },
      update: {
        sourceControlAi: {
          enabled: false,
          instructionsByOperation: {
            pullRequest: 'legacy review'
          },
          actionOverrides: {
            commitMessage: {
              agentId: 'claude',
              commandInputTemplate: '{basePrompt}\n\nrepo',
              agentArgs: '--model sonnet'
            },
            pullRequest: {
              agentId: null,
              commandInputTemplate: '{basePrompt}\n\nlegacy review'
            }
          },
          prCreationDefaults: {
            draft: true
          }
        }
      }
    })
  })

  it('clears empty repo source-control AI writes with the JSON boundary sentinel', () => {
    expect(toSourceControlAiRepoUpdate({ prCreationDefaults: { draft: null } })).toEqual({
      sourceControlAi: null
    })
  })

  it('preserves boolean-only hosted-review defaults and strips legacy null defaults on write', () => {
    expect(
      normalizeWritableRepoSourceControlAiOverrides({
        prCreationDefaults: {
          draft: true,
          useTemplate: null,
          generateDetailsOnOpen: false
        }
      })
    ).toEqual({
      prCreationDefaults: {
        draft: true,
        generateDetailsOnOpen: false
      }
    })
  })

  it('stores repo custom commands when saving a custom-command recipe', () => {
    const result = saveSourceControlActionRecipe({
      target: { type: 'repo', repoId: 'repo-1' },
      settings: settings(),
      repo: null,
      actionId: 'commitMessage',
      recipe: {
        agentId: 'custom',
        commandInputTemplate: '{basePrompt}'
      },
      customAgentCommand: 'repo-agent {prompt}'
    })

    expect(result).toMatchObject({
      update: {
        sourceControlAi: {
          customAgentCommand: 'repo-agent {prompt}',
          actionOverrides: {
            commitMessage: {
              agentId: 'custom',
              commandInputTemplate: '{basePrompt}'
            }
          }
        }
      }
    })
  })

  it('writes global recipes through a complete normalized source-control AI value', () => {
    const result = saveSourceControlActionRecipe({
      target: { type: 'global' },
      settings: settings(),
      actionId: 'pullRequest',
      recipe: {
        agentId: 'custom',
        commandInputTemplate: '{basePrompt}\n\nreview',
        agentArgs: '--verbose'
      },
      customAgentCommand: 'review-agent {prompt}'
    })

    expect(result.target).toEqual({ type: 'global' })
    expect('sourceControlAi' in result).toBe(true)
    if (!('sourceControlAi' in result)) {
      throw new Error('Expected a global save result')
    }
    expect(result.sourceControlAi.actions?.pullRequest).toEqual({
      agentId: 'custom',
      commandInputTemplate: '{basePrompt}\n\nreview',
      agentArgs: '--verbose'
    })
    expect(result.sourceControlAi.customAgentCommand).toBe('review-agent {prompt}')
    expect(result.sourceControlAi.enabled).toBe(true)
  })

  it('replaces global recipes so cleared CLI args do not survive', () => {
    const currentSettings = settings()
    currentSettings.sourceControlAi = {
      ...currentSettings.sourceControlAi!,
      actions: {
        pullRequest: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--old-model'
        }
      }
    }

    const result = saveSourceControlActionRecipe({
      target: { type: 'global' },
      settings: currentSettings,
      actionId: 'pullRequest',
      recipe: {
        agentId: 'claude',
        commandInputTemplate: '{basePrompt}',
        agentArgs: ''
      }
    })

    if (!('sourceControlAi' in result)) {
      throw new Error('Expected a global save result')
    }
    expect(result.sourceControlAi.actions?.pullRequest).toEqual({
      agentId: 'claude',
      commandInputTemplate: '{basePrompt}',
      agentArgs: ''
    })
  })

  it('writes empty repo CLI args so repository recipes can clear inherited args', () => {
    const currentSettings = settings()
    currentSettings.sourceControlAi = {
      ...currentSettings.sourceControlAi!,
      actions: {
        pullRequest: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--global-model'
        }
      }
    }

    const result = saveSourceControlActionRecipe({
      target: { type: 'repo', repoId: 'repo-1' },
      settings: currentSettings,
      repo: null,
      actionId: 'pullRequest',
      recipe: {
        agentId: 'claude',
        commandInputTemplate: '{basePrompt}',
        agentArgs: ''
      }
    })

    expect(result).toMatchObject({
      update: {
        sourceControlAi: {
          actionOverrides: {
            pullRequest: {
              agentId: 'claude',
              commandInputTemplate: '{basePrompt}',
              agentArgs: ''
            }
          }
        }
      }
    })
  })
})
