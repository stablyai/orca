import { saveSourceControlAiActionModelChoice } from './source-control-ai-action-model-choice'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  saveSourceControlActionRecipe,
  toSourceControlAiRepoUpdate
} from './source-control-ai-recipe-save'
import {
  getDefaultSourceControlAiSettings,
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi,
  resolveSourceControlAiForOperation
} from './source-control-ai'
import type { GlobalSettings } from './global-settings-types'
import type { SourceControlAiSettings } from './source-control-ai-types'
import type { Repo } from './repo-types'

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

  it('keeps the action model when saving a repo recipe', () => {
    const launchPreferences = {
      agentId: 'codex' as const,
      model: 'gpt-5.6-terra',
      options: { effort: 'high' }
    }
    const result = saveSourceControlActionRecipe({
      target: { type: 'repo', repoId: 'repo-1' },
      settings: settings(),
      repo: null,
      actionId: 'fixChecks',
      recipe: { agentId: 'codex', commandInputTemplate: '{basePrompt}', launchPreferences }
    })

    expect(result).toMatchObject({
      update: {
        sourceControlAi: {
          actionOverrides: {
            fixChecks: {
              agentId: 'codex',
              commandInputTemplate: '{basePrompt}',
              launchPreferences: {
                agentId: 'codex',
                modelSelection: {
                  base: 'default',
                  model: { agentId: 'codex', value: 'gpt-5.6-terra' },
                  options: { effort: { agentId: 'codex', value: 'high' } }
                }
              }
            }
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

describe('text action model and effort writes', () => {
  it('updates both scopes and known host maps, stripping only the matching flags from that scope', () => {
    const settings = getDefaultSettings('/tmp')
    const source = settings.sourceControlAi!
    source.discoveredModelsByAgentByHost = { 'ssh:discovered': {} }
    source.selectedModelByAgentByHost = { 'ssh:global': { claude: 'opus' } }
    source.actions = { ...source.actions, branchName: { agentArgs: '--model global --trace' } }
    const repo = {
      sourceControlAi: {
        actionOverrides: {
          branchName: {
            agentArgs:
              '--model repo --config model_reasoning_effort=low -c sandbox_mode="read-only"'
          }
        },
        modelOverridesByOperation: {
          branchName: { selectedModelByAgentByHost: { 'ssh:saved': { claude: 'sonnet' } } }
        }
      }
    }
    const before = structuredClone({ settings, repo })
    const global = saveSourceControlAiActionModelChoice({
      target: { type: 'global' },
      settings,
      repo,
      actionId: 'branchName',
      agentId: 'codex',
      change: { field: 'model', value: 'gpt-5.5' }
    })
    expect(global.target.type).toBe('global')
    if (!('sourceControlAi' in global)) {
      throw new Error('Expected global save')
    }
    expect(global.sourceControlAi.actions?.branchName?.agentArgs).toBe('--trace')
    expect(global.sourceControlAi.modelOverridesByOperation?.branchName).toEqual({
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedModelByAgentByHost: {
        'ssh:global': { codex: 'gpt-5.5' },
        'ssh:discovered': { codex: 'gpt-5.5' }
      }
    })
    const picked = saveSourceControlAiActionModelChoice({
      target: { type: 'repo', repoId: 'repo' },
      settings,
      repo,
      actionId: 'branchName',
      agentId: 'codex',
      change: { field: 'model', value: 'gpt-5.4' }
    })
    if (!('update' in picked) || !picked.update.sourceControlAi) {
      throw new Error('Expected repo save')
    }
    expect(picked.update.sourceControlAi.actionOverrides?.branchName?.agentArgs).toBe(
      '--config model_reasoning_effort=low -c sandbox_mode="read-only"'
    )
    expect(picked.update.sourceControlAi.modelOverridesByOperation?.branchName).toMatchObject({
      selectedModelByAgent: { codex: 'gpt-5.4' },
      selectedModelByAgentByHost: {
        'ssh:saved': { claude: 'sonnet', codex: 'gpt-5.4' },
        'ssh:discovered': { codex: 'gpt-5.4' }
      }
    })
    const effort = saveSourceControlAiActionModelChoice({
      target: { type: 'repo', repoId: 'repo' },
      settings,
      repo: { sourceControlAi: picked.update.sourceControlAi },
      actionId: 'branchName',
      agentId: 'codex',
      change: { field: 'effort', modelId: 'gpt-5.4', value: 'high' }
    })
    if (!('update' in effort) || !effort.update.sourceControlAi) {
      throw new Error('Expected repo effort save')
    }
    expect(effort.update.sourceControlAi.actionOverrides?.branchName?.agentArgs).toBe(
      '-c sandbox_mode="read-only"'
    )
    expect(
      effort.update.sourceControlAi.modelOverridesByOperation?.branchName?.selectedThinkingByModel
    ).toEqual({ 'gpt-5.4': 'high' })
    const cleared = saveSourceControlAiActionModelChoice({
      target: { type: 'repo', repoId: 'repo' },
      settings,
      repo: { sourceControlAi: effort.update.sourceControlAi },
      actionId: 'branchName',
      agentId: 'codex',
      change: { field: 'model', value: undefined }
    })
    if (!('update' in cleared) || !cleared.update.sourceControlAi) {
      throw new Error('Expected repo clear')
    }
    expect(
      cleared.update.sourceControlAi.modelOverridesByOperation?.branchName?.selectedModelByAgent
    ).toBeUndefined()
    expect(
      cleared.update.sourceControlAi.modelOverridesByOperation?.branchName
        ?.selectedModelByAgentByHost
    ).toEqual({ 'ssh:saved': { claude: 'sonnet' } })
    const variant = saveSourceControlAiActionModelChoice({
      target: { type: 'global' },
      settings: {
        ...settings,
        sourceControlAi: {
          ...source,
          actions: { branchName: { agentArgs: '--model provider/model#high --trace' } }
        }
      },
      actionId: 'branchName',
      agentId: 'opencode2',
      change: { field: 'effort', modelId: 'provider/model', value: 'low' }
    })
    if (!('sourceControlAi' in variant)) {
      throw new Error('Expected combined variant save')
    }
    expect(variant.sourceControlAi.actions?.branchName?.agentArgs).toBe('--trace')
    expect(variant.sourceControlAi.modelOverridesByOperation?.branchName).toMatchObject({
      selectedModelByAgent: { opencode2: 'provider/model' },
      selectedThinkingByModel: { 'provider/model': 'low' }
    })
    expect({ settings, repo }).toEqual(before)
  })
})

describe('text action model writes across hosts and editors', () => {
  function pickCommitModel(source: SourceControlAiSettings, hostKeys?: string[]) {
    const saved = saveSourceControlAiActionModelChoice({
      target: { type: 'global' },
      settings: { sourceControlAi: source },
      actionId: 'commitMessage',
      agentId: 'codex',
      hostKeys,
      change: { field: 'model', value: 'gpt-5.4-mini' }
    })
    if (!('sourceControlAi' in saved)) {
      throw new Error('Expected global save')
    }
    return normalizeSourceControlAiSettings(saved.sourceControlAi)
  }
  function resolvedModel(source: SourceControlAiSettings, hostKey: string) {
    const result = resolveSourceControlAiForOperation({
      settings: {
        sourceControlAi: source,
        commitMessageAi: projectSourceControlAiToLegacyCommitMessageAi(source)
      },
      operation: 'commitMessage',
      discoveryHostKey: hostKey
    })
    return result.ok && result.value.params.model
  }

  it('lets a later feature-wall pick take effect locally after a card pick', () => {
    const source = getDefaultSourceControlAiSettings()
    source.agentId = 'codex'
    source.discoveredModelsByAgentByHost = { local: {}, 'ssh:one': {} }
    source.selectedModelByAgentByHost = { local: { codex: 'gpt-5.6-terra' } }
    source.modelOverridesByOperation = {
      commitMessage: { selectedModelByAgentByHost: { local: { claude: 'opus' } } }
    }
    const picked = pickCommitModel(source)
    expect(picked.modelOverridesByOperation?.commitMessage).toEqual({
      selectedModelByAgent: { codex: 'gpt-5.4-mini' },
      selectedModelByAgentByHost: {
        local: { claude: 'opus' },
        'ssh:one': { codex: 'gpt-5.4-mini' }
      }
    })
    expect(resolvedModel(picked, 'local')).toBe('gpt-5.4-mini')
    // The feature-wall card edits the legacy host-agnostic model, which reconciliation carries back.
    const legacy = projectSourceControlAiToLegacyCommitMessageAi(picked)
    const afterWall = mergeLegacyCommitMessageAiIntoSourceControlAi(picked, {
      ...legacy,
      selectedModelByAgent: { ...legacy.selectedModelByAgent, codex: 'gpt-5.5' }
    })
    expect(resolvedModel(afterWall, 'local')).toBe('gpt-5.5')
    expect(resolvedModel(afterWall, 'ssh:one')).toBe('gpt-5.4-mini')
    expect(
      afterWall.modelOverridesByOperation?.commitMessage?.selectedModelByAgentByHost?.local
    ).toEqual({ claude: 'opus' })
  })

  it('writes registered hosts without discovery so they keep the pick once Arguments lose the flag', () => {
    const source = getDefaultSourceControlAiSettings()
    source.agentId = 'codex'
    source.actions = { commitMessage: { agentId: 'codex', agentArgs: '--model gpt-5.5 --trace' } }
    const picked = pickCommitModel(source, ['local', 'runtime:env-1', 'ssh:box'])
    expect(picked.actions?.commitMessage?.agentArgs).toBe('--trace')
    for (const hostKey of ['local', 'runtime:env-1', 'ssh:box']) {
      expect(resolvedModel(picked, hostKey)).toBe('gpt-5.4-mini')
    }
    const cleared = saveSourceControlAiActionModelChoice({
      target: { type: 'global' },
      settings: { sourceControlAi: picked },
      actionId: 'commitMessage',
      agentId: 'codex',
      hostKeys: ['runtime:env-1'],
      change: { field: 'model', value: undefined }
    })
    expect(
      'sourceControlAi' in cleared &&
        cleared.sourceControlAi.modelOverridesByOperation?.commitMessage
    ).toBeUndefined()
  })
})
