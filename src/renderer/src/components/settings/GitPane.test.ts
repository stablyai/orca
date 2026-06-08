import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { GitPane } from './GitPane'

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
  it('still renders its own git settings (e.g. Branch Prefix) on a matching search', () => {
    expect(renderGitPane('branch prefix')).toContain('Branch Prefix')
  })

  it('no longer renders the auto-name toggle or the relocated branch-name controls', () => {
    // Why: the auto-name toggle moved to the Git AI Author pane (it depends on
    // that feature), and its model/prompt tuning lives under Advanced -> Branch Names.
    const markup = renderGitPane('rename')
    expect(markup).not.toContain('Auto-name new workspaces from first message')
    expect(markup).not.toContain('Branch name prompt')
    expect(markup).not.toContain('Branch name model')
  })
})
