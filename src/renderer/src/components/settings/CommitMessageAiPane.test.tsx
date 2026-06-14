import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import {
  getCommitMessageModelDiscoveryHostKey,
  getCommitMessageModelDiscoveryHostKeyForScope
} from '../../../../shared/commit-message-host-key'
import { useAppStore } from '../../store'
import {
  CommitMessageAiPane,
  getCommitMessageSettingsPaneDiscoveryHostKey,
  mergeDiscoveredModelsIntoCommitMessageConfig
} from './CommitMessageAiPane'
import {
  getAiCommitModelOptions,
  readAiCommitSelectedModelId
} from './SourceControlAiCommitDefaults'
import { getCommitMessageAgentCapability } from '../../../../shared/commit-message-agent-spec'
import {
  getAgentCatalogForAction,
  getSourceControlAgentArgsPlaceholder
} from './source-control-action-recipe-options'
import { getCommitMessageAiPaneSearchEntries } from './commit-message-ai-search'
import { TooltipProvider } from '../ui/tooltip'

function renderPane(settings: GlobalSettings): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(CommitMessageAiPane, {
        settings,
        updateSettings: () => {}
      })
    )
  )
}

function buildSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    commitMessageAi: {
      enabled: false,
      agentId: null,
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: ''
    },
    ...overrides
  } as GlobalSettings
}

describe('CommitMessageAiPane', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsSearchQuery: '' })
  })

  it('renders only the opt-in control before the feature is enabled', () => {
    const markup = renderPane(buildSettings())

    expect(markup).toContain('Source Control AI')
    expect(markup).toContain('Show Source Control AI actions')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).not.toContain('Action recipes')
    expect(markup).not.toContain('Command template')
    expect(markup).not.toContain('AI Commit Agent')
    expect(markup).not.toContain('AI Commit Model')
    expect(markup).not.toContain('Default model')
    expect(markup).not.toContain('Thinking effort')
  })

  it('renders AI Commit agent and model selectors for the commit-message action', () => {
    const markup = renderPane(
      buildSettings({
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          instructionsByOperation: {},
          customAgentCommand: '',
          actions: {
            commitMessage: {
              agentId: 'omp'
            }
          },
          modelOverridesByOperation: {
            commitMessage: {
              selectedModelByAgent: { omp: 'default' }
            }
          },
          prCreationDefaults: {},
          launchActionDefaults: {}
        }
      })
    )

    expect(markup).toContain('AI Commit Agent')
    expect(markup).toContain('AI Commit Model')
    expect(markup).toContain('Used only by the AI Commit dropdown action.')
    expect(markup).toContain('OMP')
  })

  it('renders action recipes for every Source Control AI action', () => {
    const markup = renderPane(
      buildSettings({
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.5' },
          selectedThinkingByModel: { 'gpt-5.5': 'medium' },
          customPrompt: 'Use Conventional Commits.',
          customAgentCommand: ''
        }
      })
    )

    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('Action recipes')
    expect(markup).toContain('Commit message')
    expect(markup).toContain('Pull request details')
    expect(markup).toContain('Branch name')
    expect(markup).toContain('Commit failure fixes')
    expect(markup).toContain('Broken checks fixes')
    expect(markup).toContain('Conflict resolution')
    expect(markup).toContain('CLI arguments')
    expect(markup).toContain('Command template')
    expect(markup).toContain('Custom command')
    expect(markup).toContain('{basePrompt}')
    expect(markup).toContain('{stagedPatch}')
    expect(markup).toContain('Use Conventional Commits.')
    expect(markup).not.toContain('Default model')
    expect(markup).not.toContain('Thinking effort')
  })

  it('uses agent-specific CLI argument placeholders', () => {
    const markup = renderPane(
      buildSettings({
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          instructionsByOperation: {},
          customAgentCommand: '',
          actions: {
            fixChecks: {
              agentId: 'codex'
            }
          },
          prCreationDefaults: {},
          launchActionDefaults: {}
        }
      })
    )

    expect(markup).toContain('placeholder="--model gpt-5.4-mini"')
  })

  it('falls back to the preferred default agent for CLI argument placeholders', () => {
    const markup = renderPane(
      buildSettings({
        defaultTuiAgent: 'codex',
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          instructionsByOperation: {},
          customAgentCommand: '',
          actions: {},
          prCreationDefaults: {},
          launchActionDefaults: {}
        }
      })
    )

    expect(markup.match(/placeholder="--model gpt-5\.4-mini"/g)?.length ?? 0).toBeGreaterThan(0)
  })

  it('uses known model flags when building source-control CLI argument placeholders', () => {
    expect(getSourceControlAgentArgsPlaceholder('claude')).toBe('--model sonnet')
    expect(getSourceControlAgentArgsPlaceholder('codex')).toBe('--model gpt-5.4-mini')
    expect(getSourceControlAgentArgsPlaceholder('amp')).toBe('--mode smart')
    expect(getSourceControlAgentArgsPlaceholder('aider')).toBe('--model <model>')
    expect(getSourceControlAgentArgsPlaceholder('omp')).toBe('--model <model>')
  })

  it('only offers non-interactive generation agents for text generation actions', () => {
    const commitMessageAgents = getAgentCatalogForAction('commitMessage', null).map(
      (agent) => agent.id
    )
    const pullRequestAgents = getAgentCatalogForAction('pullRequest', null).map((agent) => agent.id)

    expect(commitMessageAgents).toContain('omp')
    expect(commitMessageAgents).not.toContain('aider')
    expect(pullRequestAgents).toContain('omp')
    expect(pullRequestAgents).not.toContain('aider')
    expect(getAgentCatalogForAction('fixChecks', null).map((agent) => agent.id)).toContain('aider')
  })

  it('explains which agents are supported for text-generation recipes', () => {
    const markup = renderPane(
      buildSettings({
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          instructionsByOperation: {},
          customAgentCommand: '',
          actions: {},
          prCreationDefaults: {},
          launchActionDefaults: {}
        }
      })
    )

    expect(markup).toContain('Supported agents for this recipe:')
    expect(markup).toContain('Claude, Codex')
    expect(markup).toContain('Custom command')
    expect(markup).toContain('OMP')
  })

  it('marks an unsupported saved text-recipe agent with the supported alternatives', () => {
    const markup = renderPane(
      buildSettings({
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          instructionsByOperation: {},
          customAgentCommand: '',
          actions: {
            commitMessage: {
              agentId: 'aider'
            }
          },
          prCreationDefaults: {},
          launchActionDefaults: {}
        }
      })
    )

    expect(markup).toContain(
      'Aider cannot run this text-generation recipe. Pick one of the supported agents below.'
    )
    expect(markup).toContain('Supported agents for this recipe:')
  })

  it('keeps action agent selectors constrained for long labels', () => {
    const markup = renderPane(
      buildSettings({
        commitMessageAi: {
          enabled: true,
          agentId: 'copilot',
          selectedModelByAgent: { copilot: 'gpt-5.5' },
          selectedThinkingByModel: {},
          customPrompt: '',
          customAgentCommand: ''
        }
      })
    )

    expect(markup.match(/sm:w-\[220px\]/g)?.length ?? 0).toBeGreaterThanOrEqual(6)
    expect(markup.match(/shrink-0/g)?.length ?? 0).toBeGreaterThanOrEqual(6)
  })

  it('renders saved custom action templates in action recipes', () => {
    const markup = renderPane(
      buildSettings({
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          instructionsByOperation: { commitMessage: '', pullRequest: '', branchName: '' },
          customAgentCommand: '',
          actions: {
            commitMessage: {
              agentId: 'codex',
              commandInputTemplate: 'use $best-commit-msg to write a commit'
            },
            fixChecks: {
              agentId: 'claude',
              commandInputTemplate: 'use /fix-ci-issue to fix the linked CI bug'
            }
          },
          prCreationDefaults: {},
          launchActionDefaults: {}
        }
      })
    )

    expect(markup).toContain('Source Control AI')
    expect(markup).toContain('use $best-commit-msg to write a commit')
    expect(markup).toContain('use /fix-ci-issue to fix the linked CI bug')
  })

  it('renders the custom command editor when a text action uses it', () => {
    const markup = renderPane(
      buildSettings({
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          instructionsByOperation: { commitMessage: '', pullRequest: '', branchName: '' },
          customAgentCommand: 'my-commit-writer --prompt {prompt}',
          actions: {
            commitMessage: {
              agentId: 'custom',
              commandInputTemplate: '{basePrompt}'
            }
          },
          prCreationDefaults: {},
          launchActionDefaults: {}
        }
      })
    )

    expect(markup).toContain('Used by commit-message, pull-request, and branch-name recipes')
    expect(markup).toContain('my-commit-writer --prompt {prompt}')
  })

  it('preserves in-progress trailing spaces in command template textareas', () => {
    const markup = renderPane(
      buildSettings({
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedModelByAgentByHost: {},
          discoveredModelsByAgent: {},
          discoveredModelsByAgentByHost: {},
          selectedThinkingByModel: {},
          instructionsByOperation: { commitMessage: '', pullRequest: '', branchName: '' },
          customAgentCommand: '',
          actions: {
            fixChecks: {
              commandInputTemplate: 'use /fix-ci-issue '
            }
          },
          prCreationDefaults: {},
          launchActionDefaults: {}
        }
      })
    )

    expect(markup).toContain('use /fix-ci-issue </textarea>')
  })

  it('allows default-agent recipes even when the old default generator is unsupported', () => {
    const markup = renderPane(
      buildSettings({
        defaultTuiAgent: 'aider',
        commitMessageAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customPrompt: '',
          customAgentCommand: ''
        }
      })
    )

    expect(markup).toContain('Action recipes')
    expect(markup).toContain('{basePrompt}')
    expect(markup).not.toContain('Not configured')
    expect(markup).not.toContain('Thinking effort')
  })

  it('removes the old Gemini text-generation lockout from the settings pane', () => {
    const markup = renderPane(
      buildSettings({
        commitMessageAi: {
          enabled: true,
          agentId: 'gemini',
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customPrompt: '',
          customAgentCommand: ''
        }
      })
    )

    expect(markup).toContain('Action recipes')
    expect(markup).not.toContain('Gemini Source Control AI is coming soon')
    expect(markup).not.toContain('Which model Source Control AI uses')
  })

  it('keeps action recipes discoverable in settings search metadata', () => {
    const actionRecipesEntry = getCommitMessageAiPaneSearchEntries().find(
      (entry) => entry.title === 'Action recipes'
    )

    expect(actionRecipesEntry?.keywords).toEqual(
      expect.arrayContaining(['agent', 'arguments', 'cli', 'command', 'model', 'template', 'ci'])
    )
  })

  it('keeps AI Commit agent and model settings discoverable', () => {
    const entries = getCommitMessageAiPaneSearchEntries()

    expect(entries.find((entry) => entry.title === 'AI Commit Agent')?.keywords).toEqual(
      expect.arrayContaining(['agent', 'omp', 'claude', 'codex'])
    )
    expect(entries.find((entry) => entry.title === 'AI Commit Model')?.keywords).toEqual(
      expect.arrayContaining(['model', 'omp'])
    )
  })

  it('merges discovered models without clobbering newer settings fields', () => {
    const config: SourceControlAiSettings = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'stale-model', codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'low' },
      instructionsByOperation: { commitMessage: 'Use Conventional Commits.' },
      customAgentCommand: '',
      discoveredModelsByAgent: {}
    }

    const merged = mergeDiscoveredModelsIntoCommitMessageConfig(
      config,
      'cursor',
      [{ id: 'auto', label: 'Auto' }],
      'auto'
    )

    expect(merged.instructionsByOperation.commitMessage).toBe('Use Conventional Commits.')
    expect(merged.agentId).toBe('cursor')
    expect(merged.selectedModelByAgent).toEqual({
      cursor: 'auto',
      codex: 'gpt-5.5'
    })
    expect(merged.discoveredModelsByAgent?.cursor).toEqual([{ id: 'auto', label: 'Auto' }])
    expect(merged.discoveredModelsByAgentByHost?.local?.cursor).toEqual([
      { id: 'auto', label: 'Auto' }
    ])
  })

  it('reads AI Commit operation model overrides before global model defaults', () => {
    const config: SourceControlAiSettings = {
      enabled: true,
      agentId: null,
      selectedModelByAgent: { omp: 'default' },
      selectedThinkingByModel: {},
      instructionsByOperation: {},
      customAgentCommand: '',
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: { omp: 'anthropic/claude-sonnet-4' }
        }
      }
    }

    expect(readAiCommitSelectedModelId(config, 'local', 'omp')).toBe('anthropic/claude-sonnet-4')
  })

  it('uses host-scoped discovered models for the AI Commit model picker', () => {
    const capability = getCommitMessageAgentCapability('omp')
    expect(capability).toBeDefined()
    const config: SourceControlAiSettings = {
      enabled: true,
      agentId: null,
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      instructionsByOperation: {},
      customAgentCommand: '',
      discoveredModelsByAgent: { omp: [{ id: 'local-model', label: 'Local Model' }] },
      discoveredModelsByAgentByHost: {
        'ssh:conn-1': { omp: [{ id: 'remote-model', label: 'Remote Model' }] }
      }
    }

    expect(
      getAiCommitModelOptions(config, 'ssh:conn-1', capability!).map((model) => model.id)
    ).toEqual(['default', 'remote-model'])
  })

  it('migrates the first OMP Copilot seed to the CLI default model during discovery', () => {
    const config: SourceControlAiSettings = {
      enabled: true,
      agentId: 'omp',
      selectedModelByAgent: { omp: 'github-copilot/gpt-5.4-mini' },
      selectedThinkingByModel: {},
      instructionsByOperation: {},
      customAgentCommand: '',
      discoveredModelsByAgent: {}
    }

    const merged = mergeDiscoveredModelsIntoCommitMessageConfig(
      config,
      'omp',
      [
        { id: 'default', label: 'OMP default' },
        { id: 'github-copilot/gpt-5.4-mini', label: 'Github Copilot GPT 5.4 Mini' }
      ],
      'default'
    )

    expect(merged.selectedModelByAgent.omp).toBe('default')
  })

  it('keeps SSH discovered models out of the legacy local cache', () => {
    const config: SourceControlAiSettings = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'auto' },
      selectedThinkingByModel: {},
      instructionsByOperation: {},
      customAgentCommand: '',
      discoveredModelsByAgent: { cursor: [{ id: 'auto', label: 'Auto' }] },
      selectedModelByAgentByHost: {},
      discoveredModelsByAgentByHost: {}
    }

    const merged = mergeDiscoveredModelsIntoCommitMessageConfig(
      config,
      'cursor',
      [{ id: 'remote-only', label: 'Remote Only' }],
      'remote-only',
      'ssh:conn-1'
    )

    expect(merged.selectedModelByAgent.cursor).toBe('auto')
    expect(merged.discoveredModelsByAgent?.cursor).toEqual([{ id: 'auto', label: 'Auto' }])
    expect(merged.selectedModelByAgentByHost?.['ssh:conn-1']?.cursor).toBe('remote-only')
    expect(merged.discoveredModelsByAgentByHost?.['ssh:conn-1']?.cursor).toEqual([
      { id: 'remote-only', label: 'Remote Only' }
    ])
  })

  it('keys model discovery cache by execution host', () => {
    expect(getCommitMessageModelDiscoveryHostKey(null)).toBe('local')
    expect(getCommitMessageModelDiscoveryHostKey('ssh-1')).toBe('ssh:ssh-1')
    expect(getCommitMessageModelDiscoveryHostKey(undefined)).toBe('unknown')
    expect(getCommitMessageModelDiscoveryHostKeyForScope('runtime:env-1')).toBe('runtime:env-1')
    expect(getCommitMessageModelDiscoveryHostKeyForScope('ssh-1')).toBe('ssh:ssh-1')
  })

  it('keeps local active worktree discovery scoped to local, not unknown', () => {
    expect(getCommitMessageSettingsPaneDiscoveryHostKey(buildSettings(), null, true)).toBe('local')
    expect(getCommitMessageSettingsPaneDiscoveryHostKey(buildSettings(), undefined, true)).toBe(
      'unknown'
    )
    expect(
      getCommitMessageSettingsPaneDiscoveryHostKey(
        buildSettings({ activeRuntimeEnvironmentId: 'env-1' }),
        null,
        true
      )
    ).toBe('runtime:env-1')
  })
})
