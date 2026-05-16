import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { CommitMessageAiPane } from './CommitMessageAiPane'
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
    expect(markup).toContain('Save')
    expect(markup).toContain('Saved')
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
})
