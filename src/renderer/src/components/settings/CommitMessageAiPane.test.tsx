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
  createCommitMessageInstructionDraftState,
  getCommitMessageSettingsPaneDiscoveryHostKey,
  mergeDiscoveredModelsIntoCommitMessageConfig,
  resolveCommitMessageInstructionDraftState
} from './CommitMessageAiPane'
import { COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES } from './commit-message-ai-search'

function renderPane(settings: GlobalSettings, settingsSearchQuery = ''): string {
  return renderToStaticMarkup(
    React.createElement(CommitMessageAiPane, {
      settings,
      updateSettings: () => {},
      settingsSearchQuery
    })
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

  it('updates clean instruction drafts when persisted instructions change', () => {
    const state = createCommitMessageInstructionDraftState(
      {
        commitMessage: 'commit-a',
        pullRequest: 'pr-a'
      },
      1
    )

    const resolved = resolveCommitMessageInstructionDraftState(
      state,
      {
        commitMessage: 'commit-b',
        pullRequest: 'pr-a'
      },
      1
    )

    expect(resolved.draft).toEqual({
      commitMessage: 'commit-b',
      pullRequest: 'pr-a'
    })
  })

  it('preserves dirty instruction drafts until the discard signal changes', () => {
    const state = createCommitMessageInstructionDraftState(
      {
        commitMessage: 'commit-a',
        pullRequest: 'pr-a'
      },
      1
    )
    state.draft.commitMessage = 'local edit'

    const withExternalChange = resolveCommitMessageInstructionDraftState(
      state,
      {
        commitMessage: 'commit-b',
        pullRequest: 'pr-b'
      },
      1
    )
    expect(withExternalChange.draft).toEqual({
      commitMessage: 'local edit',
      pullRequest: 'pr-b'
    })

    const afterDiscard = resolveCommitMessageInstructionDraftState(
      withExternalChange,
      {
        commitMessage: 'commit-b',
        pullRequest: 'pr-b'
      },
      2
    )
    expect(afterDiscard.draft).toEqual({
      commitMessage: 'commit-b',
      pullRequest: 'pr-b'
    })
  })

  it('renders only the opt-in control before the feature is enabled', () => {
    const markup = renderPane(buildSettings())

    expect(markup).toContain('Git AI Author')
    expect(markup).toContain('Enable Git AI Author')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).not.toContain('Orca invokes this CLI')
    expect(markup).not.toContain('Thinking Effort')
  })

  it('renders model, thinking, and collapsed commit and PR customization for enabled preset agents', () => {
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
    expect(markup).toContain('Orca invokes this CLI')
    expect(markup).toContain('Model')
    expect(markup).toContain('Thinking Effort')
    expect(markup).toContain('Commit and PR customization')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('Commit Messages')
    expect(markup).not.toContain('Pull Requests')
    expect(markup).not.toContain('Use a different model for commit message generation.')
    expect(markup).not.toContain('Creation defaults')
    expect(markup).not.toContain('Branch name model')
    expect(markup).not.toContain('Higher effort produces more careful messages')
    expect(markup).not.toContain('Use Conventional Commits.')
    expect(markup).not.toContain('Saved')
  })

  it('shows the enable row for Git AI Author search matches before the feature is enabled', () => {
    const markup = renderPane(buildSettings(), 'customization')

    expect(markup).toContain('Git AI Author')
    expect(markup).toContain('Enable Git AI Author')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).not.toContain('Commit and PR customization')
  })

  it('opens commit and PR customization for matching settings search terms', () => {
    const markup = renderPane(
      buildSettings({
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.5' },
          selectedThinkingByModel: { 'gpt-5.5': 'medium' },
          customPrompt: '',
          customAgentCommand: ''
        }
      }),
      'customization'
    )

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Commit Messages')
    expect(markup).toContain('Pull Requests')
    expect(markup).toContain('Creation defaults')
  })

  it('shows the nested commit model control for commit message model search', () => {
    const markup = renderPane(
      buildSettings({
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.5' },
          selectedThinkingByModel: { 'gpt-5.5': 'medium' },
          customPrompt: '',
          customAgentCommand: ''
        }
      }),
      'commit message model'
    )

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Commit Messages')
    expect(markup).toContain('Use a different model for commit message generation.')
  })

  it('shows the nested commit model control for commit model search', () => {
    const markup = renderPane(
      buildSettings({
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.5' },
          selectedThinkingByModel: { 'gpt-5.5': 'medium' },
          customPrompt: '',
          customAgentCommand: ''
        }
      }),
      'commit model'
    )

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Commit Messages')
    expect(markup).toContain('Use a different model for commit message generation.')
  })

  it('shows the nested pull request model control for pr model search', () => {
    const markup = renderPane(
      buildSettings({
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.5' },
          selectedThinkingByModel: { 'gpt-5.5': 'medium' },
          customPrompt: '',
          customAgentCommand: ''
        }
      }),
      'pr model'
    )

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Pull Requests')
    expect(markup).toContain(
      'Use a different model for pull request title and description generation.'
    )
  })

  it('keeps the agent and model selectors aligned for long labels', () => {
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

    expect(markup.match(/w-\[260px\]/g)).toHaveLength(2)
    expect(markup.match(/shrink-0/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('renders custom command settings for custom agents', () => {
    const markup = renderPane(
      buildSettings({
        commitMessageAi: {
          enabled: true,
          agentId: 'custom',
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customPrompt: '',
          customAgentCommand: 'ollama run llama3.1 {prompt}'
        }
      })
    )

    expect(markup).toContain('Git AI Author')
    expect(markup).toContain('Custom command')
    expect(markup).toContain('ollama run llama3.1 {prompt}')
  })

  it('shows an unconfigured state when the default agent is unsupported', () => {
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

    expect(markup).toContain('Not configured')
    expect(markup).toContain('Your default agent is Aider')
    expect(markup).toContain('Choose a supported agent or Custom')
    expect(markup).not.toContain('Which model the selected agent uses')
    expect(markup).not.toContain('Thinking Effort')
  })

  it('shows Gemini as coming soon instead of a selectable generator', () => {
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

    expect(markup).toContain('Gemini')
    expect(markup).toContain('Gemini Git AI Author is coming soon')
    expect(markup).not.toContain('Which model Git AI Author uses')
  })

  it('keeps custom command discoverable in settings search metadata', () => {
    const customCommandEntry = COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES.find(
      (entry) => entry.title === 'Custom command'
    )

    expect(customCommandEntry?.keywords).toEqual(
      expect.arrayContaining(['custom', 'command', 'ollama'])
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
