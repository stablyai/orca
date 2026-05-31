import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { shouldOpenAutoRenameBranchAdvanced } from './AutoRenameBranchFromWorkSetting'
import { GitPane, shouldShowAutoRenameBranchSetting } from './GitPane'

function renderGitPane(searchQuery: string): string {
  useAppStore.setState({ settingsSearchQuery: searchQuery })
  return renderToStaticMarkup(
    React.createElement(GitPane, {
      settings: getDefaultSettings('/tmp'),
      updateSettings: () => {},
      writeSourceControlAiSettings: async () => {},
      displayedGitUsername: 'brennan',
      settingsSearchQuery: searchQuery
    })
  )
}

describe('GitPane', () => {
  it('keeps the auto-rename branch setting visible while its prompt draft is dirty', () => {
    expect(shouldShowAutoRenameBranchSetting('zz-no-match', true)).toBe(true)
  })

  it('shows the auto-rename branch setting for advanced prompt and model searches', () => {
    expect(shouldShowAutoRenameBranchSetting('instructions', false)).toBe(true)
    expect(shouldShowAutoRenameBranchSetting('built-in prompt', false)).toBe(true)
    expect(shouldShowAutoRenameBranchSetting('thinking', false)).toBe(true)
    expect(shouldShowAutoRenameBranchSetting('override', false)).toBe(true)
  })

  it('hides the auto-rename branch setting when search misses and the prompt draft is clean', () => {
    expect(shouldShowAutoRenameBranchSetting('zz-no-match', false)).toBe(false)
  })

  it('opens auto-rename advanced controls when search matches hidden prompt or model fields', () => {
    expect(shouldOpenAutoRenameBranchAdvanced('prompt')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('model')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('instructions')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('built-in prompt')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('thinking')).toBe(true)
    expect(shouldOpenAutoRenameBranchAdvanced('override')).toBe(true)
  })

  it('renders auto-rename advanced controls for advanced-only search terms', () => {
    expect(renderGitPane('instructions')).toContain('Branch name prompt')
    expect(renderGitPane('thinking')).toContain('Branch name model')
  })

  it('keeps auto-rename advanced controls collapsed without an advanced search match', () => {
    expect(shouldOpenAutoRenameBranchAdvanced('')).toBe(false)
    expect(shouldOpenAutoRenameBranchAdvanced('creature name')).toBe(false)
  })
})
