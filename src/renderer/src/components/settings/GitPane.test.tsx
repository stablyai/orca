import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/constants'
import { TooltipProvider } from '../ui/tooltip'
import { GitPane } from './GitPane'

function renderGitPane(settings: GlobalSettings, displayedGitUsername = 'jdoe'): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(GitPane, {
        settings,
        updateSettings: () => {},
        writeSourceControlAiSettings: async () => {},
        displayedGitUsername
      })
    )
  )
}

function customPrefixSettings(branchPrefixCustom: string): GlobalSettings {
  return {
    ...getDefaultSettings('/home/test'),
    branchPrefix: 'custom',
    branchPrefixCustom
  }
}

function gitUsernamePrefixSettings(): GlobalSettings {
  return {
    ...getDefaultSettings('/home/test'),
    branchPrefix: 'git-username',
    branchPrefixCustom: ''
  }
}

describe('GitPane branch prefix feedback', () => {
  it('previews the resulting branch name and drops a redundant trailing slash', () => {
    const html = renderGitPane(customPrefixSettings('team/'))
    expect(html).toContain('team/feature')
    expect(html).not.toContain('team//feature')
  })

  it('warns when the custom prefix contains invalid characters', () => {
    const html = renderGitPane(customPrefixSettings('team x'))
    expect(html).toContain('Prefix cannot contain spaces')
  })

  it('shows neither preview nor warning when no custom prefix is set', () => {
    const html = renderGitPane(customPrefixSettings(''))
    expect(html).not.toContain('/feature')
    expect(html).not.toContain('Prefix cannot contain spaces')
    expect(html).not.toContain('No prefix will be applied')
  })

  it('explains when a custom prefix normalizes away to empty', () => {
    const html = renderGitPane(customPrefixSettings('/'))
    expect(html).toContain('No prefix will be applied')
    expect(html).not.toContain('/feature')
  })

  it('warns in git-username mode when the displayed username is invalid', () => {
    const html = renderGitPane(gitUsernamePrefixSettings(), 'team x')
    expect(html).toContain('Prefix cannot contain spaces')
  })

  it('previews in git-username mode when the displayed username is valid', () => {
    const html = renderGitPane(gitUsernamePrefixSettings(), 'jdoe/')
    expect(html).toContain('jdoe/feature')
  })
})
