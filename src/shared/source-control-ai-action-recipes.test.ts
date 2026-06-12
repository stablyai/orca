import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  projectSourceControlAiToLegacyCommitMessageAi,
  resolveSourceControlActionRecipe,
  resolveSourceControlAiForOperation
} from './source-control-ai'
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

describe('source-control AI action recipes', () => {
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
      agentArgs: '--model gpt-5.5'
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
      agentArgs: ''
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
          commandInputTemplate: '{basePrompt}\n\nGlobal checks template.'
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
      commandInputTemplate: '{basePrompt}\n\nGlobal checks template.'
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
    ).toEqual({
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
    ).toEqual({
      ok: false,
      error:
        'Agent "aider" does not support Source Control AI commit messages. Supported agents: Claude, Codex, OpenCode, Pi, Amp, Cursor, Kimi, GitHub Copilot, Antigravity, or Custom command.'
    })
  })
})
