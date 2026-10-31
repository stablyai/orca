import { normalizeSourceControlActionRecipe } from './source-control-ai-actions'
import { liftActionPermissionArgs } from './source-control-action-permission-lift'
import { editActionArgumentChoices } from './source-control-action-argument-choices'
import {
  projectSourceControlActionLaunch,
  sourceControlActionLaunchOptions
} from './source-control-action-launch-preferences'
import { saveSourceControlActionRecipe } from './source-control-ai-recipe-save'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  projectSourceControlAiToLegacyCommitMessageAi,
  resolveSourceControlActionRecipe,
  resolveSourceControlAiForOperation
} from './source-control-ai'
import type { GlobalSettings } from './global-settings-types'
import type { SourceControlActionRecipe } from './source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from './source-control-ai-types'

type RepoActionOverride = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>['fixChecks']
>

function settings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: 'codex' as const,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex' as const,
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium', 'gpt-5.4': 'high' },
      instructionsByOperation: {
        commitMessage: 'Global commit style',
        pullRequest: 'Global PR style',
        branchName: 'Global branch style'
      }
    }
  }
}

describe('source-control AI action recipes', () => {
  it('owns empty, null and unrelated Args without inheriting model or effort, but keeps permission binding', () => {
    const base = settings()
    base.agentPermissionDefault = 'own'
    base.sourceControlAi!.actions = {
      fixChecks: {
        agentId: 'claude',
        surface: 'terminal',
        launchPreferences: {
          agentId: 'claude',
          modelSelection: {
            base: 'default',
            model: { agentId: 'claude', value: 'opus' },
            options: { effort: { agentId: 'claude', value: 'high' } }
          },
          permissionMode: 'ask'
        }
      }
    }
    for (const agentArgs of ['', null, '--verbose', '--dangerously-skip-permissions']) {
      const recipe = resolveSourceControlActionRecipe({
        settings: base,
        actionId: 'fixChecks',
        repo: { sourceControlAi: { actionOverrides: { fixChecks: { agentArgs } } } }
      })
      expect(recipe.agentArgs).toBe(agentArgs ?? '')
      expect(recipe.launchPreferences).toBeUndefined()
      expect(recipe.resolvedChoiceSources?.permission).toEqual(
        base.sourceControlAi!.actions!.fixChecks!.launchPreferences
      )
      expect(recipe).not.toHaveProperty('launchPreferencesYieldToAgentArgs')
      expect(sourceControlActionLaunchOptions(recipe, 'claude').sessionOptions).toEqual({
        permissionMode: 'ask'
      })
      const own = {
        agentId: 'codex',
        modelSelection: { base: 'default', model: { agentId: 'codex', value: 'gpt-5.5' } }
      } as const
      const bound = resolveSourceControlActionRecipe({
        settings: base,
        actionId: 'fixChecks',
        repo: {
          sourceControlAi: { actionOverrides: { fixChecks: { agentArgs, launchPreferences: own } } }
        }
      })
      expect(bound.launchPreferences).toEqual(own)
      expect(sourceControlActionLaunchOptions(bound, 'claude').sessionOptions).toBeUndefined()
    }
  })
  it('resolves text action CLI args into generation params', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        pullRequest: {
          commandInputTemplate: '{basePrompt}',
          agentArgs: '  --model gpt-5.4  '
        }
      }
    }

    expect(
      resolveSourceControlAiForOperation({
        settings: base,
        repo: null,
        operation: 'pullRequest',
        discoveryHostKey: 'local'
      })
    ).toMatchObject({
      ok: true,
      value: {
        params: {
          agentArgs: '--model gpt-5.4'
        }
      }
    })
  })

  it('treats an explicit action null agent as the default agent, not the global legacy agent', () => {
    const base = settings()
    base.defaultTuiAgent = 'codex'
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      agentId: 'claude',
      selectedModelByAgent: { codex: 'gpt-5.5', claude: 'sonnet' },
      actions: {
        ...base.sourceControlAi!.actions,
        commitMessage: { agentId: null, commandInputTemplate: '{basePrompt}' }
      }
    }

    const result = resolveSourceControlAiForOperation({
      settings: base,
      repo: null,
      operation: 'commitMessage',
      discoveryHostKey: 'local'
    })
    expect(result.ok && result.value.params.agentId).toBe('codex')
    expect(result.ok && result.value.params.model).toBe('gpt-5.5')
  })

  it('treats a repo action null agent as the default agent, not the global action agent', () => {
    const base = settings()
    base.defaultTuiAgent = 'codex'
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      agentId: 'claude',
      selectedModelByAgent: { codex: 'gpt-5.5', claude: 'sonnet' }
    }
    const result = resolveSourceControlAiForOperation({
      settings: base,
      repo: {
        sourceControlAi: {
          actionOverrides: {
            commitMessage: {
              agentId: null,
              commandInputTemplate: '{basePrompt}'
            }
          }
        }
      },
      operation: 'commitMessage',
      discoveryHostKey: 'local'
    })

    expect(result.ok && result.value.params.agentId).toBe('codex')
  })

  it('resolves launch action recipes from repo overrides over global defaults', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        fixChecks: {
          agentId: 'claude',
          commandInputTemplate: '{basePrompt}\n\nglobal',
          agentArgs: '--model sonnet'
        }
      }
    }

    expect(
      resolveSourceControlActionRecipe({
        settings: base,
        repo: {
          sourceControlAi: {
            actionOverrides: {
              fixChecks: {
                agentId: 'codex',
                commandInputTemplate: '  {basePrompt}\n\nrepo  ',
                agentArgs: '  --model gpt-5.5  '
              }
            }
          }
        },
        actionId: 'fixChecks'
      })
    ).toEqual({
      agentId: 'codex',
      commandInputTemplate: '{basePrompt}\n\nrepo',
      agentArgs: '--model gpt-5.5',
      resolvedChoiceSources: {
        model: undefined,
        permission: undefined,
        canonicalAgentId: undefined,
        literalKeys: []
      }
    })
  })

  it('selects model inheritance independently of the explicit agent and permission tuple', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        fixChecks: {
          agentId: 'codex',
          launchPreferences: {
            agentId: 'codex' as const,
            modelSelection: { base: 'default', model: { agentId: 'codex', value: 'gpt-5.6-terra' } }
          }
        }
      }
    }
    const resolve = (fixChecks: SourceControlActionRecipe) =>
      resolveSourceControlActionRecipe({
        settings: base,
        repo: { sourceControlAi: { actionOverrides: { fixChecks } } },
        actionId: 'fixChecks'
      })

    expect(resolve({ agentId: 'codex', agentArgs: '--search' }).launchPreferences).toBeUndefined()
    expect(resolve({ agentId: null }).launchPreferences).toEqual(
      base.sourceControlAi.actions?.fixChecks?.launchPreferences
    )
    expect(resolve({ agentArgs: '--search' }).launchPreferences).toBeUndefined()
    expect(resolve({ agentId: 'claude' }).launchPreferences).toEqual(
      base.sourceControlAi.actions?.fixChecks?.launchPreferences
    )
    expect(sourceControlActionLaunchOptions(resolve({ agentId: 'claude' }), 'claude')).toEqual({})
    expect(
      sourceControlActionLaunchOptions(
        resolve({
          agentId: 'codex',
          launchPreferences: { agentId: 'claude', permissionMode: 'ask' }
        }),
        'codex'
      )
    ).toEqual({ sessionOptions: { model: 'gpt-5.6-terra' } })
    expect(
      resolve({
        agentId: 'codex',
        launchPreferences: { agentId: 'codex', model: 'gpt-5.5', options: { effort: 'high' } }
      }).launchPreferences
    ).toEqual({
      agentId: 'codex',
      modelSelection: {
        base: 'default',
        model: { agentId: 'codex', value: 'gpt-5.5' },
        options: { effort: { agentId: 'codex', value: 'high' } }
      }
    })
  })

  it('lets repo action recipes explicitly clear inherited CLI args', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        fixChecks: {
          agentId: 'claude',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model sonnet'
        }
      }
    }

    expect(
      resolveSourceControlActionRecipe({
        settings: base,
        repo: {
          sourceControlAi: {
            actionOverrides: {
              fixChecks: {
                agentArgs: null
              }
            }
          }
        },
        actionId: 'fixChecks'
      })
    ).toEqual({
      agentId: 'claude',
      commandInputTemplate: '{basePrompt}',
      agentArgs: '',
      resolvedChoiceSources: {
        model: undefined,
        permission: undefined,
        canonicalAgentId: undefined,
        literalKeys: []
      }
    })
  })

  it('lets repo text action null templates inherit global action templates', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        commitMessage: {
          commandInputTemplate: '{basePrompt}\n\nUse Conventional Commits.'
        }
      }
    }

    expect(
      resolveSourceControlAiForOperation({
        settings: base,
        repo: {
          sourceControlAi: {
            actionOverrides: {
              commitMessage: {
                commandInputTemplate: null
              }
            }
          }
        },
        operation: 'commitMessage',
        discoveryHostKey: 'local'
      })
    ).toMatchObject({
      ok: true,
      value: {
        params: {
          commandInputTemplate: '{basePrompt}\n\nUse Conventional Commits.'
        }
      }
    })
  })

  it('lets repo launch action null templates inherit resolved action templates', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        fixChecks: {
          agentId: 'claude',
          commandInputTemplate: '{basePrompt}\n\nGlobal checks template.',
          resolvedChoiceSources: {
            model: undefined,
            permission: undefined,
            canonicalAgentId: undefined,
            literalKeys: []
          }
        }
      }
    }

    expect(
      resolveSourceControlActionRecipe({
        settings: base,
        repo: {
          sourceControlAi: {
            actionOverrides: {
              fixChecks: {
                commandInputTemplate: null
              }
            }
          }
        },
        actionId: 'fixChecks'
      })
    ).toEqual({
      agentId: 'claude',
      commandInputTemplate: '{basePrompt}\n\nGlobal checks template.',
      resolvedChoiceSources: {
        model: undefined,
        permission: undefined,
        canonicalAgentId: undefined,
        literalKeys: []
      }
    })
  })

  it('preserves existing action templates when legacy settings are only the rollback projection', () => {
    const source = {
      ...settings().sourceControlAi!,
      actions: {
        ...settings().sourceControlAi!.actions,
        commitMessage: {
          agentId: 'codex' as const,
          commandInputTemplate: 'use $best-commit-msg to write a commit'
        },
        branchName: {
          agentId: 'claude' as const,
          commandInputTemplate: 'name this branch from {firstPrompt}'
        }
      }
    }
    const legacy = projectSourceControlAiToLegacyCommitMessageAi(source)

    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(source, legacy)

    expect(merged.actions?.commitMessage).toEqual({
      agentId: 'codex',
      commandInputTemplate: 'use $best-commit-msg to write a commit'
    })
    expect(merged.actions?.branchName).toEqual({
      agentId: 'claude',
      commandInputTemplate: 'name this branch from {firstPrompt}'
    })
  })

  it('does not let rollback enabled changes clobber independent branch action templates', () => {
    const source = {
      ...settings().sourceControlAi!,
      enabled: true,
      actions: {
        ...settings().sourceControlAi!.actions,
        commitMessage: {
          agentId: 'codex' as const,
          commandInputTemplate: 'use $best-commit-msg to write a commit'
        },
        branchName: {
          agentId: 'claude' as const,
          commandInputTemplate: 'name this branch from {firstPrompt}'
        }
      }
    }
    const legacy = {
      ...projectSourceControlAiToLegacyCommitMessageAi(source),
      enabled: false
    }

    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(source, legacy)

    expect(merged.enabled).toBe(false)
    expect(merged.actions?.commitMessage).toEqual({
      agentId: 'codex',
      commandInputTemplate: 'use $best-commit-msg to write a commit'
    })
    expect(merged.actions?.branchName).toEqual({
      agentId: 'claude',
      commandInputTemplate: 'name this branch from {firstPrompt}'
    })
  })

  it('does not let stale legacy branch instructions clobber independent branch templates', () => {
    const source = {
      ...settings().sourceControlAi!,
      instructionsByOperation: {
        ...settings().sourceControlAi!.instructionsByOperation,
        commitMessage: 'old shared prompt',
        branchName: 'old shared prompt'
      },
      actions: {
        ...settings().sourceControlAi!.actions,
        commitMessage: {
          agentId: 'codex' as const,
          commandInputTemplate: '{basePrompt}\n\nold shared prompt'
        },
        branchName: {
          agentId: 'claude' as const,
          commandInputTemplate: 'name this branch from {firstPrompt}'
        }
      }
    }
    const legacy = {
      ...projectSourceControlAiToLegacyCommitMessageAi(source),
      customPrompt: 'rollback changed commit prompt'
    }

    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(source, legacy)

    expect(merged.actions?.commitMessage).toEqual({
      agentId: 'codex',
      commandInputTemplate: '{basePrompt}\n\nrollback changed commit prompt'
    })
    expect(merged.instructionsByOperation.branchName).toBe('old shared prompt')
    expect(merged.actions?.branchName).toEqual({
      agentId: 'claude',
      commandInputTemplate: 'name this branch from {firstPrompt}'
    })
  })

  it('lets rollback custom-agent changes clear a commit action agent override', () => {
    const source = {
      ...settings().sourceControlAi!,
      agentId: 'codex' as const,
      customAgentCommand: '',
      actions: {
        ...settings().sourceControlAi!.actions,
        commitMessage: {
          agentId: 'codex' as const,
          commandInputTemplate: 'use $best-commit-msg to write a commit'
        }
      }
    }
    const legacy = {
      ...projectSourceControlAiToLegacyCommitMessageAi(source),
      agentId: 'custom' as const,
      customAgentCommand: 'custom-agent {prompt}'
    }

    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(source, legacy)

    expect(merged.agentId).toBe('custom')
    expect(merged.customAgentCommand).toBe('custom-agent {prompt}')
    expect(merged.actions?.commitMessage).toEqual({
      agentId: 'custom',
      commandInputTemplate: 'use $best-commit-msg to write a commit'
    })
  })

  it('preserves an explicitly empty global text action template as invalid config', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        commitMessage: { commandInputTemplate: '' }
      }
    }

    expect(
      resolveSourceControlAiForOperation({
        settings: base,
        repo: null,
        operation: 'commitMessage',
        discoveryHostKey: 'local'
      })
    ).toMatchObject({
      ok: false,
      error: 'Command template is empty for commit messages.'
    })
  })

  it('lists supported agents when a text action uses an unsupported saved agent', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        commitMessage: {
          agentId: 'aider',
          commandInputTemplate: '{basePrompt}'
        }
      }
    }

    expect(
      resolveSourceControlAiForOperation({
        settings: base,
        repo: null,
        operation: 'commitMessage',
        discoveryHostKey: 'local'
      })
    ).toMatchObject({
      ok: false,
      error:
        'Agent "aider" does not support Source Control AI commit messages. Supported agents: OMP, Claude, Codex, OpenCode, OpenCode 2, Pi, Amp, Cursor, Kimi, Muse, DeepSeek Harness, GitHub Copilot, Antigravity, Jcode, or Custom command.'
    })
  })
})

it('keeps scoped defaults, complete legacy ownership, independent bindings and literal dispositions', () => {
  const global = liftActionPermissionArgs({
    agentId: 'claude' as const,
    agentArgs: '--model sonnet --effort high --verbose',
    launchPreferences: { agentId: 'claude' as const, permissionMode: 'ask' as const }
  })
  const selection = { base: 'inherit' as const, model: { agentId: 'claude' as const, value: null } }
  const base = settings()
  base.sourceControlAi!.actions = { fixChecks: global }
  const scoped = {
    launchPreferences: {
      agentId: 'codex' as const,
      permissionMode: 'ask' as const,
      modelSelection: selection
    }
  }
  const resolve = (row: RepoActionOverride) =>
    resolveSourceControlActionRecipe({
      settings: base,
      repo: { sourceControlAi: { actionOverrides: { fixChecks: row } } },
      actionId: 'fixChecks'
    })
  const plan = projectSourceControlActionLaunch(resolve(scoped), 'claude', { basePrompt: 'fix' })
  expect(plan.agentArgs).toBe('--verbose')
  expect(plan.sessionOptions).toEqual({ effort: 'high' })
  const typedBase = {
    ...base,
    sourceControlAi: {
      ...base.sourceControlAi!,
      actions: {
        fixChecks: {
          agentId: 'claude' as const,
          agentArgs: '--verbose',
          launchPreferences: {
            agentId: 'claude' as const,
            model: 'opus',
            options: { effort: 'high' }
          }
        }
      }
    }
  }
  const sparse = {
    sourceControlAi: {
      actionOverrides: {
        fixChecks: {
          launchPreferences: { agentId: 'claude' as const, permissionMode: 'ask' as const }
        }
      }
    }
  }
  const shown = resolveSourceControlActionRecipe({
    settings: typedBase,
    repo: sparse,
    actionId: 'fixChecks'
  })
  const saved = saveSourceControlActionRecipe({
    target: { type: 'repo', repoId: 'r' },
    settings: typedBase,
    repo: sparse,
    actionId: 'fixChecks',
    recipe: shown
  })
  if (!('update' in saved)) {
    throw new Error('Missing repository update')
  }
  const reopened = resolveSourceControlActionRecipe({
    settings: typedBase,
    repo: { sourceControlAi: saved.update.sourceControlAi ?? undefined },
    actionId: 'fixChecks'
  })
  expect(projectSourceControlActionLaunch(reopened, 'claude', { basePrompt: 'fix' })).toEqual(
    projectSourceControlActionLaunch(shown, 'claude', { basePrompt: 'fix' })
  )
  const foreign = resolve({
    launchPreferences: {
      agentId: 'claude',
      modelSelection: {
        base: 'inherit',
        model: { agentId: 'codex', value: null }
      }
    }
  })
  expect(projectSourceControlActionLaunch(foreign, 'claude', { basePrompt: 'fix' })).toMatchObject({
    agentArgs: '--model sonnet --verbose',
    sessionOptions: { effort: 'high' }
  })
  const legacy = normalizeSourceControlActionRecipe(
    {
      launchPreferences: {
        agentId: 'claude',
        model: 'opus',
        effort: 'medium'
      }
    },
    true
  )!
  expect(legacy.launchPreferences).toEqual({
    agentId: 'claude',
    modelSelection: {
      base: 'default',
      model: { agentId: 'claude', value: 'opus' },
      options: { effort: { agentId: 'claude', value: 'medium' } }
    }
  })
  const cleared = editActionArgumentChoices(
    legacy,
    'claude',
    { model: 'opus', options: { effort: 'medium' } },
    { model: null, options: { effort: null } },
    ''
  )
  expect(cleared.launchPreferences?.modelSelection?.base).toBe('default')
  expect(
    projectSourceControlActionLaunch(
      resolve({ launchPreferences: cleared.launchPreferences }),
      'claude',
      { basePrompt: 'fix' }
    )
  ).toMatchObject({
    agentArgs: '--model sonnet  --effort high --verbose'
  })
  for (const raw of [undefined, '', null, '--verbose']) {
    const row = { ...scoped, ...(raw !== undefined ? { agentArgs: raw } : {}) }
    expect(
      normalizeSourceControlActionRecipe(
        { ...row, agentArgs: raw === null ? undefined : raw },
        true
      )?.launchPreferences
    ).toEqual(scoped.launchPreferences)
    if (raw !== undefined) {
      expect(
        projectSourceControlActionLaunch(resolve(row), 'claude', { basePrompt: 'fix' })
          .sessionOptions
      ).toBeUndefined()
    }
  }
  const empty = { agentId: 'claude', modelSelection: { base: 'default' } }
  expect(
    normalizeSourceControlActionRecipe(
      { launchPreferences: { ...empty, model: 'ignored', options: { effort: 'high' } } },
      true
    )?.launchPreferences
  ).toEqual(empty)
  expect(
    normalizeSourceControlActionRecipe(
      { launchPreferences: { ...empty, modelSelection: { base: 'inherit' } } },
      true
    )
  ).toBeUndefined()
  for (const modelSelection of [
    { base: 'invalid' },
    { base: 'inherit', model: { agentId: 'unknown', value: null } },
    { base: 'default', options: { model: { agentId: 'claude', value: 'opaque' } } }
  ]) {
    expect(() =>
      normalizeSourceControlActionRecipe(
        { launchPreferences: { agentId: 'claude', modelSelection } },
        true
      )
    ).toThrow()
  }
})
