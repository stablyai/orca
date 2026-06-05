import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { GitPane, shouldShowAutoRenameBranchSetting } from './GitPane'

function renderGitPane(searchQuery: string): string {
  useAppStore.setState({ settingsSearchQuery: searchQuery })
  return renderToStaticMarkup(
    React.createElement(GitPane, {
      settings: getDefaultSettings('/tmp'),
      updateSettings: () => {},
      displayedGitUsername: 'brennan',
      settingsSearchQuery: searchQuery
    })
  )
}

describe('GitPane', () => {
  it('shows the auto-rename branch toggle when search matches its identity terms', () => {
    expect(shouldShowAutoRenameBranchSetting('creature name')).toBe(true)
    expect(shouldShowAutoRenameBranchSetting('auto-name')).toBe(true)
  })

  it('hides the auto-rename branch toggle when search misses', () => {
    expect(shouldShowAutoRenameBranchSetting('zz-no-match')).toBe(false)
  })

  it('renders only the toggle copy, not the relocated branch-name model/prompt controls', () => {
    const markup = renderGitPane('rename')
    expect(markup).toContain('Auto-name from first message')
    // Why: branch-name model + prompt customization moved to Git AI Author -> Advanced.
    expect(markup).not.toContain('Branch name prompt')
    expect(markup).not.toContain('Branch name model')
  })
})
