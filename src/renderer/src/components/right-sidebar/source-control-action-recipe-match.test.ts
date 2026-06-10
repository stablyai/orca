import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings, Repo } from '../../../../shared/types'
import { sourceControlActionRecipeMatchesTarget } from './source-control-action-recipe-match'

function settings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      actions: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model sonnet'
        }
      }
    }
  }
}

describe('sourceControlActionRecipeMatchesTarget', () => {
  it('returns true when the launch recipe matches the global saved recipe', () => {
    expect(
      sourceControlActionRecipeMatchesTarget({
        actionId: 'resolveConflicts',
        target: { type: 'global' },
        recipe: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model sonnet'
        },
        settings: settings()
      })
    ).toBe(true)
  })

  it('returns false when the repo target has no saved override yet', () => {
    expect(
      sourceControlActionRecipeMatchesTarget({
        actionId: 'resolveConflicts',
        target: { type: 'repo', repoId: 'repo-1' },
        recipe: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model sonnet'
        },
        settings: settings(),
        repo: { sourceControlAi: { enabled: true } } satisfies Pick<Repo, 'sourceControlAi'>
      })
    ).toBe(false)
  })

  it('returns true when the launch recipe matches the repo saved recipe', () => {
    expect(
      sourceControlActionRecipeMatchesTarget({
        actionId: 'fixCommitFailure',
        target: { type: 'repo', repoId: 'repo-1' },
        recipe: {
          agentId: 'claude',
          commandInputTemplate: '{basePrompt}\n\nrepo only',
          agentArgs: ''
        },
        settings: settings(),
        repo: {
          sourceControlAi: {
            enabled: true,
            actionOverrides: {
              fixCommitFailure: {
                agentId: 'claude',
                commandInputTemplate: '{basePrompt}\n\nrepo only'
              }
            }
          }
        } satisfies Pick<Repo, 'sourceControlAi'>
      })
    ).toBe(true)
  })

  it('returns true when a repo recipe inherits the global command template', () => {
    const currentSettings = settings()
    currentSettings.sourceControlAi = {
      ...currentSettings.sourceControlAi!,
      actions: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}\n\ncustom global',
          agentArgs: '--model sonnet'
        }
      }
    }

    expect(
      sourceControlActionRecipeMatchesTarget({
        actionId: 'resolveConflicts',
        target: { type: 'repo', repoId: 'repo-1' },
        recipe: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}\n\ncustom global',
          agentArgs: '--model sonnet'
        },
        settings: currentSettings,
        repo: {
          sourceControlAi: {
            enabled: true,
            actionOverrides: {
              resolveConflicts: {
                commandInputTemplate: null
              }
            }
          }
        } satisfies Pick<Repo, 'sourceControlAi'>
      })
    ).toBe(true)
  })

  it('returns true when a repo recipe explicitly clears inherited agent args', () => {
    expect(
      sourceControlActionRecipeMatchesTarget({
        actionId: 'resolveConflicts',
        target: { type: 'repo', repoId: 'repo-1' },
        recipe: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: ''
        },
        settings: settings(),
        repo: {
          sourceControlAi: {
            enabled: true,
            actionOverrides: {
              resolveConflicts: {
                agentArgs: null
              }
            }
          }
        } satisfies Pick<Repo, 'sourceControlAi'>
      })
    ).toBe(true)
  })
})
