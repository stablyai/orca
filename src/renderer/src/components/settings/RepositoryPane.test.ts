import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { useAppStore } from '../../store'
import {
  canBrowseProjectWorktreeFolder,
  getRepositoryPaneSearchEntries,
  matchesRepositoryIdentitySearch,
  RepositoryPane
} from './RepositoryPane'
import { matchesSettingsSearch } from './settings-search'
import { TooltipProvider } from '../ui/tooltip'

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'Example Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

describe('RepositoryPane search entries', () => {
  it('keeps renamed hook sections reachable through settings search', () => {
    const entries = getRepositoryPaneSearchEntries(repo)

    expect(matchesSettingsSearch('setup script', entries)).toBe(true)
    expect(matchesSettingsSearch('archive script', entries)).toBe(true)
    expect(matchesSettingsSearch('setup command', entries)).toBe(true)
    expect(matchesSettingsSearch('archive command', entries)).toBe(true)
    expect(matchesSettingsSearch('advanced', entries)).toBe(true)
    expect(matchesSettingsSearch('command source', entries)).toBe(true)
    expect(matchesSettingsSearch('local settings scripts', entries)).toBe(true)
    expect(matchesSettingsSearch('../worktrees', entries)).toBe(true)
    expect(matchesSettingsSearch('worktree path', entries)).toBe(true)
    expect(matchesSettingsSearch('worktree folder', entries)).toBe(true)
  })

  it('matches project identity searches on display name and path only', () => {
    expect(matchesRepositoryIdentitySearch('example repo', repo)).toBe(true)
    expect(matchesRepositoryIdentitySearch('/tmp/repo', repo)).toBe(true)
    expect(matchesRepositoryIdentitySearch('setup script', repo)).toBe(false)
  })

  it('renders full hook controls when search matches the project name', () => {
    useAppStore.setState({
      settingsSearchQuery: 'Example Repo',
      settingsSearchInputQuery: 'Example Repo'
    })

    try {
      const html = renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(RepositoryPane, {
            repo,
            yamlHooks: null,
            hasHooksFile: false,
            hooksInspectionReady: true,
            mayNeedUpdate: false,
            updateRepo: vi.fn(),
            removeProject: vi.fn()
          })
        )
      )

      expect(html).toContain('Worktree Hooks')
      expect(html).toContain('Setup Script')
      expect(html).toContain('Archive Script')
      expect(html).toContain('Custom GitHub Issue Command')
    } finally {
      useAppStore.setState({
        settingsSearchQuery: '',
        settingsSearchInputQuery: ''
      })
    }
  })

  it('renders the worktree folder setting for Git repos but not folder repos', () => {
    const gitHtml = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(RepositoryPane, {
          repo,
          yamlHooks: null,
          hasHooksFile: false,
          hooksInspectionReady: true,
          mayNeedUpdate: false,
          updateRepo: vi.fn(),
          removeProject: vi.fn()
        })
      )
    )
    const folderHtml = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(RepositoryPane, {
          repo: { ...repo, kind: 'folder' },
          yamlHooks: null,
          hasHooksFile: false,
          hooksInspectionReady: true,
          mayNeedUpdate: false,
          updateRepo: vi.fn(),
          removeProject: vi.fn()
        })
      )
    )

    expect(gitHtml).toContain('Worktree Folder')
    expect(gitHtml).toContain('lucide-folder-open')
    expect(folderHtml).not.toContain('Worktree Folder')
  })

  it('hides the worktree folder Browse button for SSH and remote runtime projects', () => {
    const render = (project: Repo): string =>
      renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(RepositoryPane, {
            repo: project,
            yamlHooks: null,
            hasHooksFile: false,
            hooksInspectionReady: true,
            mayNeedUpdate: false,
            updateRepo: vi.fn(),
            removeProject: vi.fn()
          })
        )
      )

    expect(render({ ...repo, connectionId: 'ssh-1' })).not.toContain('lucide-folder-open')

    expect(canBrowseProjectWorktreeFolder(repo, 'env-1')).toBe(false)
    expect(canBrowseProjectWorktreeFolder(repo, '  ')).toBe(true)
  })
})
