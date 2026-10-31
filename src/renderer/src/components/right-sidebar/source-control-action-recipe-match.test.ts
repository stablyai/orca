import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import { sourceControlActionRecipeMatchesTarget } from './source-control-action-recipe-match'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'

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
  it('compares the same live document after trimming its residual and gaps', () => {
    const current = settings()
    const recipe = {
      agentId: 'codex' as const,
      agentArgs: '',
      argumentChoices: { syntaxAgent: 'codex' as const, nodes: [{ at: 0, text: '-c model=o3' }] }
    }
    current.sourceControlAi!.actions!.resolveConflicts = {
      ...recipe,
      agentArgs: '   ',
      argumentChoices: { ...recipe.argumentChoices, nodes: [{ at: 3, text: '-c model=o3' }] }
    }
    expect(
      sourceControlActionRecipeMatchesTarget({
        actionId: 'resolveConflicts',
        target: { type: 'global' },
        recipe,
        settings: current
      })
    ).toBe(true)
  })

  it('returns true when the launch recipe matches the repo saved recipe', () => {
    expect(
      sourceControlActionRecipeMatchesTarget({
        actionId: 'fixCommitFailure',
        target: { type: 'repo', repoId: 'repo-1' },
        recipe: {
          agentId: 'claude',
          commandInputTemplate: '{basePrompt}\n\nrepo only'
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

it('distinguishes inheriting arguments from an explicit clear when deciding whether to save', () => {
  const base = settings()
  const recipe = { agentId: 'codex' as const, commandInputTemplate: '{basePrompt}' }
  base.sourceControlAi!.actions = { fixChecks: recipe }
  expect(
    sourceControlActionRecipeMatchesTarget({
      actionId: 'fixChecks',
      target: { type: 'global' },
      settings: base,
      recipe
    })
  ).toBe(true)
  expect(
    sourceControlActionRecipeMatchesTarget({
      actionId: 'fixChecks',
      target: { type: 'global' },
      settings: base,
      recipe: { ...recipe, agentArgs: '' }
    })
  ).toBe(false)
  const repo = {
    sourceControlAi: {
      actionOverrides: {
        fixChecks: {
          launchPreferences: { agentId: 'codex' as const, permissionMode: 'ask' as const }
        }
      }
    }
  }
  base.sourceControlAi!.actions = {
    fixChecks: {
      ...recipe,
      launchPreferences: {
        agentId: 'codex',
        modelSelection: { base: 'default', model: { agentId: 'codex', value: 'o3' } }
      }
    }
  }
  const selected = resolveSourceControlActionRecipe({ settings: base, repo, actionId: 'fixChecks' })
  const changed = {
    ...base,
    sourceControlAi: {
      ...base.sourceControlAi!,
      actions: {
        fixChecks: {
          ...recipe,
          launchPreferences: {
            agentId: 'codex' as const,
            modelSelection: {
              base: 'default' as const,
              model: { agentId: 'codex' as const, value: 'gpt-5.4' }
            }
          }
        }
      }
    }
  }
  expect(
    sourceControlActionRecipeMatchesTarget({
      actionId: 'fixChecks',
      target: { type: 'repo', repoId: 'r' },
      settings: changed,
      repo,
      recipe: selected
    })
  ).toBe(false)
})
