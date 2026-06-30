import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Globe, Settings } from 'lucide-react'
import type { CmdJQuickAction } from './quick-actions'
import {
  CMD_J_PALETTE_QUERY_MAX_BYTES,
  buildCmdJActionResults,
  buildCmdJSettingsResults,
  isCmdJPaletteQueryTooLarge,
  rankCmdJMiddleResults,
  type CmdJActionResult,
  type CmdJSettingsResult
} from './palette-results'
import { hasCmdJProjectSearchCandidates, searchCmdJProjectResults } from './palette-project-results'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import type { Project, ProjectGroup, ProjectHostSetup, Repo } from '../../../../shared/types'

const noopRun: CmdJQuickAction['run'] = async () => ({ status: 'ok' })
const available: CmdJQuickAction['isAvailable'] = () => ({ available: true })

const actions: CmdJQuickAction[] = [
  {
    id: 'new-browser-tab',
    kind: 'action',
    title: 'New Browser Tab',
    description: 'Open a browser tab.',
    icon: Globe,
    verbKeywords: ['new browser', 'new browser tab'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'new-terminal-tab',
    kind: 'action',
    title: 'New Terminal Tab',
    description: 'Open a terminal tab.',
    icon: Globe,
    verbKeywords: ['new terminal', 'new terminal tab'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'new-markdown-file',
    kind: 'action',
    title: 'New Markdown File',
    description: 'Create markdown.',
    icon: Globe,
    verbKeywords: ['new markdown', 'new mark'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'create-workspace',
    kind: 'action',
    title: 'Create Worktree',
    description: 'Create worktree.',
    icon: Globe,
    verbKeywords: ['create worktree', 'add worktree', 'new worktree'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'delete-workspace',
    kind: 'action',
    title: 'Delete Worktree',
    description: 'Delete the current worktree.',
    icon: Globe,
    verbKeywords: ['delete worktree', 'delete current worktree', 'remove worktree'],
    isAvailable: available,
    run: noopRun
  },
  {
    id: 'add-quick-command',
    kind: 'action',
    title: 'Add Quick Command',
    description: 'Create a saved terminal command.',
    icon: Globe,
    verbKeywords: ['add quick command', 'new quick command'],
    isAvailable: available,
    run: noopRun
  }
]

const sections: SettingsNavSection[] = [
  {
    id: 'general',
    title: 'General',
    description: 'Workspace defaults.',
    icon: Settings,
    searchEntries: [
      {
        title: 'Orca CLI',
        description: 'Register or remove the orca shell command.',
        keywords: ['cli', 'path', 'terminal', 'command', 'shell command'],
        cmdJKeywords: ['cli', 'path', 'command', 'shell command'],
        targetSectionId: 'cli'
      }
    ],
    group: 'setup'
  },
  {
    id: 'terminal',
    title: 'Terminal',
    description: 'Shell configuration.',
    icon: Settings,
    searchEntries: [{ title: 'Terminal Font' }],
    group: 'workflows'
  },
  {
    id: 'browser',
    title: 'Browser',
    description: 'Cookie import setup.',
    icon: Settings,
    searchEntries: [{ title: 'Default Browser URL' }],
    group: 'workflows'
  },
  {
    id: 'servers',
    title: 'Remote Orca Servers',
    description: 'Pair remote Orca runtimes.',
    icon: Settings,
    searchEntries: [{ title: 'Remote Orca Servers' }],
    group: 'remote'
  },
  {
    id: 'ssh',
    title: 'SSH Hosts',
    description: 'Remote hosts over SSH.',
    icon: Settings,
    searchEntries: [{ title: 'SSH Connections' }],
    group: 'remote'
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme and chrome.',
    icon: Settings,
    searchEntries: [{ title: 'Theme' }],
    group: 'interface'
  },
  {
    id: 'agents',
    title: 'Agents',
    description: 'Manage AI agents.',
    icon: Settings,
    searchEntries: [{ title: 'Default Agent' }],
    group: 'setup'
  },
  {
    id: 'quick-commands',
    title: 'Quick Commands',
    description: 'Saved commands.',
    icon: Settings,
    searchEntries: [{ title: 'Command Scope' }],
    group: 'workflows'
  }
]

function top(query: string): string | undefined {
  return rankCmdJMiddleResults({
    query,
    settingsResults: buildCmdJSettingsResults(sections),
    actionResults: buildCmdJActionResults(actions)
  })[0]?.id
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Cmd+J palette middle-band ranking', () => {
  it.each([
    ['new terminal', 'new-terminal-tab'],
    ['new markdown', 'new-markdown-file'],
    ['new browser', 'new-browser-tab'],
    ['create worktree', 'create-workspace'],
    ['add worktree', 'create-workspace'],
    ['new worktree', 'create-workspace'],
    ['delete worktree', 'delete-workspace'],
    ['remove worktree', 'delete-workspace'],
    ['terminal settings', 'settings:terminal'],
    ['browser settings', 'settings:browser'],
    ['ssh', 'settings:ssh'],
    ['agents', 'settings:agents'],
    ['new terminal settings', 'settings:terminal'],
    ['new mark', 'new-markdown-file'],
    ['appear', 'settings:appearance'],
    ['terminal', 'settings:terminal'],
    ['browser', 'settings:browser'],
    ['quick commands', 'settings:quick-commands'],
    ['add quick command', 'add-quick-command'],
    ['orca cli', 'settings:general:cli'],
    ['shell command', 'settings:general:cli']
  ])('ranks %s first', (query, expectedId) => {
    expect(top(query)).toBe(expectedId)
  })

  it('builds targeted settings rows for Settings subsections', () => {
    const cliResult = buildCmdJSettingsResults(sections).find(
      (result) => result.id === 'settings:general:cli'
    )

    expect(cliResult).toMatchObject({
      title: 'Orca CLI',
      description: 'Register or remove the orca shell command.',
      sectionId: 'general',
      targetSectionId: 'cli'
    })
  })

  it('does not match settings on one-character or description-only queries', () => {
    expect(top('t')).toBeUndefined()
    expect(top('cookie import')).toBeUndefined()
  })

  it('normalizes accepted multiline pasted queries without regex replacement', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')

    expect(top('  new\n\tterminal  ')).toBe('new-terminal-tab')

    const usedWhitespaceReplace = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
    )
    expect(usedWhitespaceReplace).toBe(false)
  })

  it('rejects oversized pasted queries before reading candidate keywords', () => {
    const oversizedQuery = 'secret-palette-query'.repeat(CMD_J_PALETTE_QUERY_MAX_BYTES)
    const setting = {
      id: 'settings:throwing',
      kind: 'settings',
      title: 'Throwing Setting',
      description: '',
      icon: Settings,
      sectionId: 'general',
      order: 0,
      get configKeywords(): string[] {
        throw new Error('oversized palette queries must not scan settings keywords')
      }
    } as CmdJSettingsResult
    const action = {
      id: 'throwing-action',
      kind: 'action',
      title: 'Throwing Action',
      description: '',
      icon: Globe,
      order: 0,
      isAvailable: available,
      run: noopRun,
      get verbKeywords(): string[] {
        throw new Error('oversized palette queries must not scan action keywords')
      }
    } as CmdJActionResult

    expect(isCmdJPaletteQueryTooLarge(oversizedQuery)).toBe(true)
    expect(
      rankCmdJMiddleResults({
        query: oversizedQuery,
        settingsResults: [setting],
        actionResults: [action]
      })
    ).toEqual([])
  })
})

function repo(id: string, displayName: string, projectGroupId?: string | null): Repo {
  return {
    id,
    path: path.join('/repos', displayName),
    displayName,
    badgeColor: '#999999',
    addedAt: 1,
    projectGroupId
  } as Repo
}

function project(id: string, displayName: string): Project {
  return {
    id,
    displayName,
    badgeColor: '#999999',
    sourceRepoIds: [],
    createdAt: 1,
    updatedAt: 1
  }
}

function setup(id: string, projectId: string, hostId: string, repoId: string): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId: hostId as ProjectHostSetup['hostId'],
    repoId,
    path: path.join('/repos', repoId),
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1
  }
}

function projectGroup(id: string, name: string, parentGroupId: string | null = null): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 1,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('Cmd+J project and repo-group search', () => {
  it('finds a Project Group by name', () => {
    const [result] = searchCmdJProjectResults({
      query: 'infra',
      projectGroups: [projectGroup('group-1', 'Infrastructure')],
      repos: [],
      projects: [],
      projectHostSetups: []
    })

    expect(result).toMatchObject({
      kind: 'project-group',
      title: 'Infrastructure',
      description: 'Repo group',
      rowKey: 'project-group:group-1'
    })
  })

  it('finds a Project by project name and a repo-backed fallback by repo name', () => {
    const projectResults = searchCmdJProjectResults({
      query: 'api',
      projectGroups: [],
      repos: [repo('repo-1', 'legacy-api'), repo('repo-2', 'source-folder')],
      projects: [project('project-1', 'API Service')],
      projectHostSetups: [setup('setup-1', 'project-1', 'local', 'repo-1')]
    })
    const fallbackResults = searchCmdJProjectResults({
      query: 'source',
      projectGroups: [],
      repos: [repo('repo-1', 'legacy-api'), repo('repo-2', 'source-folder')],
      projects: [project('project-1', 'API Service')],
      projectHostSetups: [setup('setup-1', 'project-1', 'local', 'repo-1')]
    })

    expect(projectResults.map((result) => [result.title, result.rowKey])).toEqual([
      ['API Service', 'project:project-1']
    ])
    expect(fallbackResults.map((result) => [result.title, result.rowKey])).toEqual([
      ['source-folder', 'repo:repo-2']
    ])
  })

  it('uses setup-specific project header keys for multi-setup projects on one host', () => {
    const results = searchCmdJProjectResults({
      query: 'platform',
      projectGroups: [],
      repos: [repo('repo-1', 'platform-a'), repo('repo-2', 'platform-b')],
      projects: [project('project-1', 'Platform')],
      projectHostSetups: [
        setup('setup-1', 'project-1', 'local', 'repo-1'),
        setup('setup-2', 'project-1', 'local', 'repo-2')
      ]
    })

    expect(results.map((result) => result.rowKey)).toEqual([
      'project:project-1::setup:repo-1',
      'project:project-1::setup:repo-2'
    ])
  })

  it('suppresses raw Project records without renderable repo header targets', () => {
    const results = searchCmdJProjectResults({
      query: 'orphan',
      projectGroups: [],
      repos: [],
      projects: [project('project-1', 'Orphan Project')],
      projectHostSetups: []
    })

    expect(results).toEqual([])
  })

  it('suppresses repo-backed projects when the sidebar cannot render their header row', () => {
    const results = searchCmdJProjectResults({
      query: 'archived',
      projectGroups: [],
      repos: [repo('repo-1', 'archived-service')],
      projects: [project('project-1', 'Archived Service')],
      projectHostSetups: [setup('setup-1', 'project-1', 'local', 'repo-1')],
      renderableRepoIds: new Set()
    })

    expect(results).toEqual([])
  })

  it('reports searchable project candidates even when a query has no match', () => {
    expect(
      hasCmdJProjectSearchCandidates({
        projectGroups: [projectGroup('group-1', 'Infrastructure')],
        repos: [],
        projects: [],
        projectHostSetups: []
      })
    ).toBe(true)
    expect(
      searchCmdJProjectResults({
        query: 'zzzz',
        projectGroups: [projectGroup('group-1', 'Infrastructure')],
        repos: [],
        projects: [],
        projectHostSetups: []
      })
    ).toEqual([])
  })

  it('rejects oversized project queries before reading names', () => {
    const oversizedQuery = 'secret-palette-query'.repeat(CMD_J_PALETTE_QUERY_MAX_BYTES)
    const throwingGroup = {
      get id() {
        throw new Error('oversized palette queries must not scan project groups')
      },
      get name() {
        throw new Error('oversized palette queries must not scan project groups')
      }
    } as unknown as ProjectGroup
    const throwingRepo = {
      get id() {
        throw new Error('oversized palette queries must not scan repos')
      },
      get displayName() {
        throw new Error('oversized palette queries must not scan repos')
      }
    } as unknown as Repo

    expect(
      searchCmdJProjectResults({
        query: oversizedQuery,
        projectGroups: [throwingGroup],
        repos: [throwingRepo],
        projects: [],
        projectHostSetups: []
      })
    ).toEqual([])
  })
})
