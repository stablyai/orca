import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
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
    expect(html).not.toContain('which Git rejects')
  })

  it('previews in git-username mode when the displayed username is valid', () => {
    const html = renderGitPane(gitUsernamePrefixSettings(), 'jdoe/')
    expect(html).toContain('jdoe/feature')
  })

  it('previews the lowercased git username that new branches use', () => {
    const html = renderGitPane(gitUsernamePrefixSettings(), 'EurFelux')
    expect(html).toContain('eurfelux/feature')
    expect(html).not.toContain('EurFelux')
  })

  it('does not preview a git username whose lowercase form is not a valid ref', () => {
    const html = renderGitPane(gitUsernamePrefixSettings(), 'Alice.LOCK')
    expect(html).toContain(
      'No prefix will be applied because lowercasing this username ends in .lock, which Git rejects.'
    )
    expect(html).not.toContain('Alice.LOCK')
    expect(html).not.toContain('alice.lock')
  })
})
