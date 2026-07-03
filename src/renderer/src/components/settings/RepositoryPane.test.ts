// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Project, Repo, TerminalTab } from '../../../../shared/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { useAppStore } from '../../store'
import {
  getRepositoryPaneSearchEntries,
  matchesRepositoryIdentitySearch,
  RepositoryPane
} from './RepositoryPane'
import { matchesSettingsSearch } from './settings-search'
import { TooltipProvider } from '../ui/tooltip'

let container: HTMLDivElement
let root: Root

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'Example Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

const project: Project = {
  id: 'project-1',
  displayName: 'Example Project',
  badgeColor: '#000000',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function activeAgent(paneKey: string, worktreeId: string): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'Implement runtime switch',
    updatedAt: 1,
    stateStartedAt: 1,
    agentType: 'codex',
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId,
    stateHistory: []
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('RepositoryPane search entries', () => {
  it('keeps renamed hook sections reachable through settings search', () => {
    const entries = getRepositoryPaneSearchEntries(repo, { isLocalWindowsProject: true })

    expect(matchesSettingsSearch('setup script', entries)).toBe(true)
    expect(matchesSettingsSearch('archive script', entries)).toBe(true)
    expect(matchesSettingsSearch('setup command', entries)).toBe(true)
    expect(matchesSettingsSearch('archive command', entries)).toBe(true)
    expect(matchesSettingsSearch('advanced', entries)).toBe(true)
    expect(matchesSettingsSearch('runtime', entries)).toBe(true)
    expect(matchesSettingsSearch('wsl', entries)).toBe(true)
    expect(matchesSettingsSearch('windows host', entries)).toBe(true)
    expect(matchesSettingsSearch('command source', entries)).toBe(true)
    expect(matchesSettingsSearch('local settings scripts', entries)).toBe(true)
    expect(matchesSettingsSearch('../worktrees', entries)).toBe(true)
    expect(matchesSettingsSearch('worktree path', entries)).toBe(true)
  })

  it('omits project runtime search for remote or unsupported repos', () => {
    expect(matchesSettingsSearch('project runtime', getRepositoryPaneSearchEntries(repo))).toBe(
      false
    )
    expect(
      matchesSettingsSearch(
        'project runtime',
        getRepositoryPaneSearchEntries(
          {
            ...repo,
            connectionId: 'builder',
            executionHostId: 'ssh:builder'
          },
          { windowsRuntimeSupported: true }
        )
      )
    ).toBe(false)
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

  it('warns about live terminals and active tasks before project runtime changes', () => {
    const worktreeId = 'repo-1::/tmp/repo'
    useAppStore.setState({
      settingsSearchQuery: 'Example Repo',
      settingsSearchInputQuery: 'Example Repo',
      settings: getDefaultSettings('/tmp'),
      tabsByWorktree: {
        [worktreeId]: [terminalTab('tab-1', worktreeId), terminalTab('tab-2', worktreeId)]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1'],
        'tab-2': ['pty-2']
      },
      agentStatusByPaneKey: {
        'tab-2:0': activeAgent('tab-2:0', worktreeId)
      }
    })

    act(() => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(RepositoryPane, {
            repo,
            project,
            yamlHooks: null,
            hasHooksFile: false,
            hooksInspectionReady: true,
            mayNeedUpdate: false,
            updateRepo: vi.fn(),
            removeProject: vi.fn(),
            isLocalWindowsProject: true,
            wslAvailable: true,
            wslDistros: ['Ubuntu-24.04'],
            wslCapabilitiesLoading: false,
            updateProject: vi.fn()
          })
        )
      )
    })

    expect(container.textContent).toContain('2 live terminals')
    expect(container.textContent).toContain('1 active task')
    expect(container.textContent).toContain('finish or restart')
  })
})
