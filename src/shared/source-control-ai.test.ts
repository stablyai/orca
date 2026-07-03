import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  clearSourceControlAiModelChoiceForHost,
  hasConfiguredSourceControlAiInstructions,
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeRepoSourceControlAiOverrides,
  projectSourceControlAiToLegacyCommitMessageAi,
  resolveSourceControlAiEnabled,
  readSourceControlAiModelChoiceForHost,
  resolveSourceControlAiForOperation,
  resolveSourceControlAiPrCreationDefaults,
  selectSourceControlAiModelChoiceForHost,
  sourceControlAiSettingsFromLegacy
} from './source-control-ai'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiOperation
} from './source-control-ai-types'
import type { GlobalSettings } from './types'

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

function resolve(operation: SourceControlAiOperation, overrides?: RepoSourceControlAiOverrides) {
  const result = resolveSourceControlAiForOperation({
    settings: settings(),
    repo: overrides ? { sourceControlAi: overrides } : null,
    operation,
    discoveryHostKey: 'local',
    prCreationProductDefaults: {
      draft: false,
      useTemplate: false,
      generateDetailsOnOpen: false,
      openAfterCreate: false
    }
  })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.value
}

describe('source-control AI resolution', () => {
  it('uses the global default model for every operation', () => {
    expect(resolve('commitMessage').params.model).toBe('gpt-5.5')
    expect(resolve('pullRequest').params.model).toBe('gpt-5.5')
    expect(resolve('branchName').params.model).toBe('gpt-5.5')
  })

  it('resolves generation config and PR defaults when Source Control AI actions are hidden', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      enabled: false,
      prCreationDefaults: {
        draft: true,
        useTemplate: true,
        generateDetailsOnOpen: false,
        openAfterCreate: false
      }
    }

    const generation = resolveSourceControlAiForOperation({
      settings: base,
      repo: null,
      operation: 'pullRequest'
    })
    expect(generation.ok).toBe(true)
    expect(generation.ok && generation.value.params.model).toBe('gpt-5.5')
    expect(
      resolveSourceControlAiPrCreationDefaults({
        settings: base,
        repo: {
          sourceControlAi: {
            prCreationDefaults: {
              draft: null,
              generateDetailsOnOpen: true,
              openAfterCreate: true
            }
          }
        },
        prCreationProductDefaults: {
          draft: false,
          useTemplate: false,
          generateDetailsOnOpen: false,
          openAfterCreate: false
        }
      })
    ).toEqual({
      draft: true,
      useTemplate: true,
      generateDetailsOnOpen: true,
      openAfterCreate: true
    })
  })

  it('lets repo-hidden Source Control AI actions keep operation generation valid', () => {
    const result = resolveSourceControlAiForOperation({
      settings: settings(),
      repo: { sourceControlAi: { enabled: false } },
      operation: 'branchName',
      discoveryHostKey: 'local'
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.params.model).toBe('gpt-5.5')
  })

  it('lets repo action visibility override the global default', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      enabled: false
    }

    expect(resolveSourceControlAiEnabled({ settings: base, repo: null })).toBe(false)
    expect(
      resolveSourceControlAiEnabled({
        settings: base,
        repo: { sourceControlAi: { enabled: true } }
      })
    ).toBe(true)

    base.sourceControlAi.enabled = true
    expect(
      resolveSourceControlAiEnabled({
        settings: base,
        repo: { sourceControlAi: { enabled: false } }
      })
    ).toBe(false)
  })

  it('resolves PR defaults even when generation config is invalid', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      agentId: 'custom',
      customAgentCommand: '',
      prCreationDefaults: {
        draft: false,
        useTemplate: true,
        generateDetailsOnOpen: true,
        openAfterCreate: false
      }
    }

    const generation = resolveSourceControlAiForOperation({
      settings: base,
      repo: null,
      operation: 'pullRequest'
    })
    expect(generation.ok).toBe(false)
    expect(
      resolveSourceControlAiPrCreationDefaults({
        settings: base,
        repo: { sourceControlAi: { prCreationDefaults: { draft: true } } }
      })
    ).toEqual({
      draft: true,
      useTemplate: true,
      generateDetailsOnOpen: true,
      openAfterCreate: false
    })
  })

  it('treats a normalized null agent as default instead of using stale legacy agent', () => {
    const base = settings()
    base.defaultTuiAgent = 'codex'
    base.commitMessageAi = {
      ...base.commitMessageAi!,
      agentId: 'claude',
      selectedModelByAgent: { claude: 'opus' },
      selectedThinkingByModel: { opus: 'max' }
    }
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      agentId: null,
      selectedModelByAgent: { codex: 'gpt-5.4' }
    }

    const result = resolveSourceControlAiForOperation({
      settings: base,
      repo: null,
      operation: 'commitMessage',
      discoveryHostKey: 'local'
    })
    expect(result.ok && result.value.params.agentId).toBe('codex')
    expect(result.ok && result.value.params.model).toBe('gpt-5.4')
  })

  it('lets a global operation model override win over the global default', () => {
    const base = settings()
    base.sourceControlAi!.modelOverridesByOperation = {
      pullRequest: { selectedModelByAgent: { codex: 'gpt-5.4' } }
    }
    const result = resolveSourceControlAiForOperation({
      settings: base,
      repo: null,
      operation: 'pullRequest',
      discoveryHostKey: 'local'
    })
    expect(result.ok && result.value.params.model).toBe('gpt-5.4')
  })

  it('lets a repo operation model override win over global operation override', () => {
    const base = settings()
    base.sourceControlAi!.modelOverridesByOperation = {
      commitMessage: { selectedModelByAgent: { codex: 'gpt-5.4' } }
    }
    const result = resolveSourceControlAiForOperation({
      settings: base,
      repo: {
        sourceControlAi: {
          modelOverridesByOperation: {
            commitMessage: { selectedModelByAgent: { codex: 'gpt-5.4-mini' } }
          }
        }
      },
      operation: 'commitMessage',
      discoveryHostKey: 'local'
    })
    expect(result.ok && result.value.params.model).toBe('gpt-5.4-mini')
  })

  it('uses the repo custom command before the global custom command', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        commitMessage: {
          agentId: 'custom',
          commandInputTemplate: '{basePrompt}'
        }
      },
      customAgentCommand: 'global-agent {prompt}'
    }

    const result = resolveSourceControlAiForOperation({
      settings: base,
      repo: {
        sourceControlAi: {
          customAgentCommand: 'repo-agent {prompt}'
        }
      },
      operation: 'commitMessage',
      discoveryHostKey: 'local'
    })

    expect(result.ok && result.value.params.customAgentCommand).toBe('repo-agent {prompt}')
  })

  it('resolves thinking effort with override precedence and model default fallback', () => {
    expect(resolve('commitMessage').params.thinkingLevel).toBe('medium')
    expect(
      resolve('commitMessage', {
        modelOverridesByOperation: {
          commitMessage: {
            selectedModelByAgent: { codex: 'gpt-5.4' },
            selectedThinkingByModel: { 'gpt-5.4': 'xhigh' }
          }
        }
      }).params.thinkingLevel
    ).toBe('xhigh')

    const base = settings()
    base.sourceControlAi!.selectedThinkingByModel = {
      'gpt-5.5': 'unsupported'
    } as Record<string, string>
    const result = resolveSourceControlAiForOperation({
      settings: base,
      repo: null,
      operation: 'commitMessage',
      discoveryHostKey: 'local'
    })
    expect(result.ok && result.value.params.thinkingLevel).toBe('low')
  })

  it('resolves repo instructions as replacement overrides, including explicit empty', () => {
    expect(resolve('commitMessage').params.customPrompt).toBe('Global commit style')
    expect(
      resolve('commitMessage', {
        instructionsByOperation: { commitMessage: null }
      }).params.customPrompt
    ).toBe('Global commit style')
    expect(
      resolve('commitMessage', {
        instructionsByOperation: { commitMessage: '' }
      }).params.customPrompt
    ).toBe('')
    expect(
      resolve('commitMessage', {
        instructionsByOperation: { commitMessage: 'Repo commit style' }
      }).params.customPrompt
    ).toBe('Repo commit style')
    expect(resolve('branchName').params.customPrompt).toBe('Global branch style')
    expect(
      resolve('branchName', {
        instructionsByOperation: { branchName: 'Repo branch style' }
      }).params.customPrompt
    ).toBe('Repo branch style')
  })

  it('does not treat null repo instructions as configured overrides', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      instructionsByOperation: {
        commitMessage: '',
        pullRequest: '',
        branchName: ''
      }
    }

    expect(
      hasConfiguredSourceControlAiInstructions({
        settings: base,
        repo: { sourceControlAi: { instructionsByOperation: { commitMessage: null } } },
        operation: 'commitMessage'
      })
    ).toBe(false)
    expect(
      hasConfiguredSourceControlAiInstructions({
        settings: base,
        repo: { sourceControlAi: { instructionsByOperation: { commitMessage: '' } } },
        operation: 'commitMessage'
      })
    ).toBe(true)
  })

  it('resolves repo tri-state PR defaults through inherit on and off', () => {
    expect(resolve('pullRequest').prCreationDefaults.draft).toBe(false)
    expect(
      resolve('pullRequest', {
        prCreationDefaults: { draft: true, openAfterCreate: false }
      }).prCreationDefaults
    ).toMatchObject({ draft: true, openAfterCreate: false })
  })

  it('maps legacy custom prompt to released split instructions', () => {
    const migrated = sourceControlAiSettingsFromLegacy({
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: {},
      customPrompt: 'Legacy commit prompt',
      customAgentCommand: ''
    })
    expect(migrated.instructionsByOperation.commitMessage).toBe('Legacy commit prompt')
    expect(migrated.instructionsByOperation.pullRequest).toBe('')
    expect(migrated.instructionsByOperation.branchName).toBe('Legacy commit prompt')
  })

  it('merges legacy commit-message updates without wiping PR-only settings', () => {
    const base = settings().sourceControlAi!
    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(base, {
      enabled: false,
      agentId: 'claude',
      selectedModelByAgent: { claude: 'sonnet' },
      selectedThinkingByModel: { sonnet: 'medium' },
      customPrompt: 'Legacy commit prompt',
      customAgentCommand: 'claude'
    })

    expect(merged).toMatchObject({
      enabled: false,
      agentId: 'claude',
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium', 'gpt-5.4': 'high' },
      customAgentCommand: 'claude',
      instructionsByOperation: {
        commitMessage: 'Legacy commit prompt',
        pullRequest: 'Global PR style',
        branchName: 'Global branch style'
      }
    })
    expect(merged.modelOverridesByOperation?.commitMessage).toEqual({
      selectedModelByAgent: { claude: 'sonnet' },
      selectedThinkingByModel: { sonnet: 'medium' }
    })
  })

  it('can map explicit legacy PR generation instructions for old runtime callers', () => {
    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(
      undefined,
      {
        enabled: true,
        agentId: 'codex',
        selectedModelByAgent: { codex: 'gpt-5.5' },
        selectedThinkingByModel: {},
        customPrompt: 'Legacy PR prompt',
        customAgentCommand: ''
      },
      { pullRequestInstructionsFromLegacy: true }
    )

    expect(merged.instructionsByOperation.pullRequest).toBe('Legacy PR prompt')
  })

  it('projects commit-message operation model overrides into legacy settings', () => {
    const legacy = projectSourceControlAiToLegacyCommitMessageAi({
      ...settings().sourceControlAi!,
      selectedModelByAgent: { codex: 'gpt-5.5', claude: 'sonnet' },
      selectedModelByAgentByHost: {
        local: { codex: 'gpt-5.5' },
        'ssh:conn-1': { codex: 'gpt-5.5', claude: 'sonnet' }
      },
      selectedThinkingByModel: {
        'gpt-5.4': 'high',
        'gpt-5.5': 'medium'
      },
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: { codex: 'gpt-5.4' },
          selectedModelByAgentByHost: {
            local: { codex: 'gpt-5.4' },
            'ssh:conn-1': { codex: 'gpt-5.4-mini' }
          },
          selectedThinkingByModel: {
            'gpt-5.4': 'xhigh',
            'gpt-5.4-mini': 'medium'
          }
        },
        pullRequest: {
          selectedModelByAgent: { codex: 'gpt-5.2' },
          selectedThinkingByModel: { 'gpt-5.2': 'low' }
        }
      }
    })

    expect(legacy.selectedModelByAgent).toMatchObject({
      codex: 'gpt-5.4',
      claude: 'sonnet'
    })
    expect(legacy.selectedModelByAgentByHost).toMatchObject({
      local: { codex: 'gpt-5.4' },
      'ssh:conn-1': { codex: 'gpt-5.4-mini', claude: 'sonnet' }
    })
    expect(legacy.selectedThinkingByModel).toMatchObject({
      'gpt-5.4': 'xhigh',
      'gpt-5.4-mini': 'medium',
      'gpt-5.5': 'medium'
    })
    expect(legacy.selectedThinkingByModel['gpt-5.2']).toBeUndefined()
  })

  it('merges projected legacy commit-message models without changing PR defaults', () => {
    const source = {
      ...settings().sourceControlAi!,
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium' },
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: { codex: 'gpt-5.4' },
          selectedThinkingByModel: { 'gpt-5.4': 'high' }
        }
      }
    }
    const legacy = projectSourceControlAiToLegacyCommitMessageAi(source)
    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(source, legacy)

    expect(merged.selectedModelByAgent.codex).toBe('gpt-5.5')
    expect(merged.modelOverridesByOperation?.commitMessage?.selectedModelByAgent?.codex).toBe(
      'gpt-5.4'
    )

    const base = settings()
    base.sourceControlAi = merged
    expect(
      resolveSourceControlAiForOperation({
        settings: base,
        repo: null,
        operation: 'commitMessage',
        discoveryHostKey: 'local'
      })
    ).toMatchObject({ ok: true, value: { params: { model: 'gpt-5.4' } } })
    expect(
      resolveSourceControlAiForOperation({
        settings: base,
        repo: null,
        operation: 'pullRequest',
        discoveryHostKey: 'local'
      })
    ).toMatchObject({ ok: true, value: { params: { model: 'gpt-5.5' } } })
  })

  it('does not synthesize a commit-message override from projected global defaults', () => {
    const source = {
      ...settings().sourceControlAi!,
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium' },
      modelOverridesByOperation: undefined
    }
    const legacy = projectSourceControlAiToLegacyCommitMessageAi(source)
    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(source, legacy)

    expect(merged.selectedModelByAgent.codex).toBe('gpt-5.5')
    expect(merged.modelOverridesByOperation?.commitMessage).toBeUndefined()
  })

  it('merges only rollback legacy model deltas into commit-message overrides', () => {
    const source = {
      ...settings().sourceControlAi!,
      selectedModelByAgent: { codex: 'gpt-5.5', claude: 'sonnet' },
      selectedModelByAgentByHost: {
        local: { codex: 'gpt-5.5', claude: 'sonnet' }
      },
      selectedThinkingByModel: {
        'gpt-5.5': 'medium',
        sonnet: 'high'
      },
      modelOverridesByOperation: undefined
    }
    const legacy = projectSourceControlAiToLegacyCommitMessageAi(source)
    legacy.selectedModelByAgent = {
      ...legacy.selectedModelByAgent,
      codex: 'gpt-5.4'
    }
    legacy.selectedModelByAgentByHost = {
      ...legacy.selectedModelByAgentByHost,
      local: {
        ...legacy.selectedModelByAgentByHost?.local,
        codex: 'gpt-5.4'
      }
    }

    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(source, legacy)

    expect(merged.selectedModelByAgent).toEqual({ codex: 'gpt-5.5', claude: 'sonnet' })
    expect(merged.modelOverridesByOperation?.commitMessage).toEqual({
      selectedModelByAgent: { codex: 'gpt-5.4' },
      selectedModelByAgentByHost: { local: { codex: 'gpt-5.4' } }
    })
  })

  it('removes projected commit-message overrides cleared by legacy settings', () => {
    const source = {
      ...settings().sourceControlAi!,
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium' },
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: { codex: 'gpt-5.4' },
          selectedThinkingByModel: { 'gpt-5.4': 'high' }
        }
      }
    }
    const legacy = projectSourceControlAiToLegacyCommitMessageAi(source)
    delete legacy.selectedModelByAgent.codex
    delete legacy.selectedThinkingByModel['gpt-5.4']

    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(source, legacy)

    expect(merged.modelOverridesByOperation?.commitMessage).toBeUndefined()
  })

  it('reads and selects host-scoped model choices with local fallback rules', () => {
    const localChoice = selectSourceControlAiModelChoiceForHost(
      undefined,
      'local',
      'codex',
      'gpt-5.4'
    )
    expect(localChoice).toEqual({
      selectedModelByAgent: { codex: 'gpt-5.4' },
      selectedModelByAgentByHost: { local: { codex: 'gpt-5.4' } }
    })

    const remoteChoice = selectSourceControlAiModelChoiceForHost(
      localChoice,
      'ssh:conn-1',
      'codex',
      'remote-model'
    )
    expect(readSourceControlAiModelChoiceForHost(remoteChoice, 'local', 'codex')).toBe('gpt-5.4')
    expect(readSourceControlAiModelChoiceForHost(remoteChoice, 'ssh:conn-1', 'codex')).toBe(
      'remote-model'
    )
    expect(
      readSourceControlAiModelChoiceForHost(remoteChoice, 'ssh:conn-2', 'codex')
    ).toBeUndefined()
    expect(
      readSourceControlAiModelChoiceForHost(
        { selectedModelByAgent: { codex: 'global-model' } },
        'local',
        'codex'
      )
    ).toBe('global-model')
  })

  it('clears only the selected host model override when inheriting', () => {
    const cleared = clearSourceControlAiModelChoiceForHost(
      {
        selectedModelByAgent: { codex: 'local-model' },
        selectedModelByAgentByHost: {
          local: { codex: 'local-model' },
          'ssh:conn-1': { codex: 'remote-model' }
        },
        selectedThinkingByModel: { 'remote-model': 'high' }
      },
      'local',
      'codex'
    )

    expect(cleared).toEqual({
      selectedModelByAgentByHost: {
        'ssh:conn-1': { codex: 'remote-model' }
      },
      selectedThinkingByModel: { 'remote-model': 'high' }
    })
  })

  it('normalizes repo overrides defensively and preserves explicit inherit sentinels', () => {
    const normalized = normalizeRepoSourceControlAiOverrides({
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: {
            codex: 'gpt-5.4',
            claude: 42,
            constructor: 'polluted'
          },
          selectedModelByAgentByHost: {
            local: { codex: 'gpt-5.4' },
            'ssh:conn-1': { codex: 'remote-model', claude: false },
            malformed: 'not-a-record',
            prototype: { codex: 'polluted' }
          },
          selectedThinkingByModel: {
            'gpt-5.4': 'xhigh',
            'remote-model': 'high',
            bad: true,
            constructor: 'polluted'
          }
        },
        pullRequest: {
          selectedModelByAgent: []
        },
        branchName: {
          selectedModelByAgent: { codex: 'gpt-5.4' }
        },
        unknown: {
          selectedModelByAgent: { codex: 'ignored' }
        }
      },
      instructionsByOperation: {
        commitMessage: null,
        pullRequest: '',
        branchName: 'branch style',
        unknown: 'ignored'
      },
      prCreationDefaults: {
        draft: true,
        useTemplate: null,
        generateDetailsOnOpen: 'yes',
        openAfterCreate: false
      }
    })

    expect(normalized).toEqual({
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: { codex: 'gpt-5.4' },
          selectedModelByAgentByHost: {
            local: { codex: 'gpt-5.4' },
            'ssh:conn-1': { codex: 'remote-model' }
          },
          selectedThinkingByModel: {
            'gpt-5.4': 'xhigh',
            'remote-model': 'high'
          }
        },
        branchName: {
          selectedModelByAgent: { codex: 'gpt-5.4' }
        }
      },
      instructionsByOperation: {
        commitMessage: null,
        pullRequest: '',
        branchName: 'branch style'
      },
      actionOverrides: {
        pullRequest: {
          commandInputTemplate: '{basePrompt}'
        },
        branchName: {
          commandInputTemplate: '{basePrompt}\n\nbranch style'
        }
      },
      prCreationDefaults: {
        draft: true,
        useTemplate: null,
        openAfterCreate: false
      }
    })
    expect(normalizeRepoSourceControlAiOverrides(null)).toBeUndefined()
    expect(normalizeRepoSourceControlAiOverrides([])).toBeUndefined()
  })

  it('preserves repo null command templates without requiring another override field', () => {
    expect(
      normalizeRepoSourceControlAiOverrides({
        instructionsByOperation: {
          commitMessage: 'legacy repo style'
        },
        actionOverrides: {
          commitMessage: {
            commandInputTemplate: null
          }
        }
      })
    ).toEqual({
      instructionsByOperation: {
        commitMessage: 'legacy repo style'
      },
      actionOverrides: {
        commitMessage: {
          commandInputTemplate: null
        }
      }
    })
  })
})
