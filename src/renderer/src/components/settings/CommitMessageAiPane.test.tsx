import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CommitMessageAiSettings, GlobalSettings } from '../../../../shared/types'
import { getCommitMessageModelDiscoveryHostKey } from '../../../../shared/commit-message-host-key'
import { useAppStore } from '../../store'
import {
  CommitMessageAiPane,
  mergeDiscoveredModelsIntoCommitMessageConfig
} from './CommitMessageAiPane'
import { COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES } from './commit-message-ai-search'

function renderPane(settings: GlobalSettings): string {
  return renderToStaticMarkup(
    React.createElement(CommitMessageAiPane, {
      settings,
      updateSettings: () => {}
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

  it('renders only the opt-in control before the feature is enabled', () => {
    const markup = renderPane(buildSettings())

    expect(markup).toContain('AI Commit Messages')
    expect(markup).toContain('Enable AI commit messages')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).not.toContain('Which agent drafts your commit messages')
    expect(markup).not.toContain('Thinking effort')
  })

  it('renders model, thinking, and prompt controls for enabled preset agents', () => {
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
    expect(markup).toContain('Which agent drafts your commit messages')
    expect(markup).toContain('Model')
    expect(markup).toContain('Thinking effort')
    expect(markup).toContain('Higher effort produces more careful messages')
    expect(markup).toContain('Use Conventional Commits.')
  })

  it('keeps the agent selector wide enough for GitHub Copilot', () => {
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

    expect(markup).toContain('w-[220px]')
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

    expect(markup).toContain('AI Commit Messages')
    expect(markup).toContain('Custom command')
    expect(markup).toContain('ollama run llama3.1 {prompt}')
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
    const config: CommitMessageAiSettings = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'stale-model', codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'low' },
      customPrompt: 'Use Conventional Commits.',
      customAgentCommand: '',
      discoveredModelsByAgent: {}
    }

    const merged = mergeDiscoveredModelsIntoCommitMessageConfig(
      config,
      'cursor',
      [{ id: 'auto', label: 'Auto' }],
      'auto'
    )

    expect(merged.customPrompt).toBe('Use Conventional Commits.')
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
    const config: CommitMessageAiSettings = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'auto' },
      selectedThinkingByModel: {},
      customPrompt: '',
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
  })
})
