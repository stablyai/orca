import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Globe, Settings } from 'lucide-react'
import type { CmdJQuickAction } from './quick-actions'
import {
  CMD_J_PALETTE_QUERY_MAX_BYTES,
  bestCmdJPaletteSectionQualityClass,
  buildCmdJActionResults,
  buildCmdJSettingsResults,
  isCmdJPaletteQueryTooLarge,
  rankCmdJMiddleResults,
  type CmdJActionResult,
  type CmdJSettingsResult
} from './palette-results'
import { hasCmdJProjectSearchCandidates, searchCmdJProjectResults } from './palette-project-results'
import { PALETTE_QUERY_MAX_TOKENS } from '@/lib/palette-match/palette-query'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'

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

function rankMiddle(query: string): ReturnType<typeof rankCmdJMiddleResults> {
  return rankCmdJMiddleResults({
    query,
    settingsResults: buildCmdJSettingsResults(sections),
    actionResults: buildCmdJActionResults(actions)
  })
}

function top(query: string): string | undefined {
  return rankMiddle(query)[0]?.id
}

describe('action keyword folding', () => {
  it('folds verbKeywords so a raw-cased command still reaches exact-intent', () => {
    // Why: the query is folded before ranking, so a plugin command titled `Format Document`
    // could never satisfy rules 1/3/4 and sank below any prefix-matching workspace.
    const [folded] = buildCmdJActionResults([
      {
        id: 'quick-action:format',
        kind: 'action',
        title: 'Format Document',
        description: 'Format the open file',
        verbKeywords: ['Format Document', 'FORMAT  DOC']
      } as (typeof actions)[number]
    ])
    expect(folded.verbKeywords).toEqual(['format document', 'format doc'])
  })
})

const overTokenLimitQuery = Array.from(
  { length: PALETTE_QUERY_MAX_TOKENS + 1 },
  (_, index) => `token${index}`
).join(' ')

function throwingSettingsResult(): CmdJSettingsResult {
  return {
    id: 'settings:throwing',
    kind: 'settings',
    title: 'Throwing Setting',
    description: '',
    icon: Settings,
    sectionId: 'general',
    order: 0,
    get configKeywords(): string[] {
      throw new Error('rejected palette queries must not scan settings keywords')
    }
  } as CmdJSettingsResult
}

function throwingActionResult(): CmdJActionResult {
  return {
    id: 'throwing-action',
    kind: 'action',
    title: 'Throwing Action',
    description: '',
    icon: Globe,
    order: 0,
    isAvailable: available,
    run: noopRun,
    get verbKeywords(): string[] {
      throw new Error('rejected palette queries must not scan action keywords')
    }
  } as CmdJActionResult
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

  it('drops candidates that cover a minority of the words typed', () => {
    // Why: "linear triage" used to surface the Linear and Integrations panes on the
    // "linear" token alone, with the unmatched word costing nothing. See screenshot report.
    const integrationSections: SettingsNavSection[] = [
      {
        id: 'linear',
        title: 'Linear',
        description: 'How Linear works in Orca.',
        icon: Settings,
        searchEntries: [],
        group: 'capabilities'
      },
      {
        id: 'integrations',
        title: 'Integrations',
        description: 'Connect GitHub, GitLab, and Linear.',
        icon: Settings,
        searchEntries: [],
        group: 'setup'
      }
    ]
    const rank = (query: string): string[] =>
      rankCmdJMiddleResults({
        query,
        settingsResults: buildCmdJSettingsResults(integrationSections),
        actionResults: []
      }).map((result) => result.id)

    expect(rank('linear triage')).toEqual([])
    expect(rank('linear')).toEqual(['settings:linear', 'settings:integrations'])
    // Why: a majority still counts, so one stray word cannot blank an otherwise good match.
    expect(rank('linear integrations triage')).toEqual(['settings:integrations'])
  })

  it('drops verb-prefixed settings queries whose middle words match nothing', () => {
    // Why: the verb-plus-settings-keyword rule reads only the head and tail of the query, so
    // "new terminal <junk> browser settings" used to win on those two ends alone.
    expect(top('new terminal sparkles glitter browser settings')).toBeUndefined()
    expect(top('new terminal settings')).toBe('settings:terminal')
  })

  it('keeps out-of-order partial-word matches when every query word lands somewhere', () => {
    expect(top('font term')).toBe('settings:terminal')
    expect(top('font sparkles')).toBeUndefined()
  })

  it('ignores navigation filler words when measuring coverage', () => {
    // Why: "open"/"go to" carry no intent, so they must not read as unmatched words
    // and blank the band mid-query.
    expect(top('open terminal settings')).toBe('settings:terminal')
    expect(top('go to ssh settings')).toBe('settings:ssh')
    expect(top('change the terminal font')).toBe('settings:terminal')
  })

  it('counts non-latin query words instead of discarding them', () => {
    // Why: tokenizing on ASCII only let a localized query skip the coverage rule entirely.
    expect(top('ssh 主机 设置')).toBeUndefined()
    expect(top('ssh 设置')).toBeUndefined()
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

    expect(isCmdJPaletteQueryTooLarge(oversizedQuery)).toBe(true)
    expect(
      rankCmdJMiddleResults({
        query: oversizedQuery,
        settingsResults: [throwingSettingsResult()],
        actionResults: [throwingActionResult()]
      })
    ).toEqual([])
  })

  it('rejects queries past the shared unique-token ceiling before reading keywords', () => {
    expect(
      rankCmdJMiddleResults({
        query: overTokenLimitQuery,
        settingsResults: [throwingSettingsResult()],
        actionResults: [throwingActionResult()]
      })
    ).toEqual([])
    // Why: the ceiling counts unique tokens, so a repeated phrase still ranks.
    expect(top('terminal settings '.repeat(PALETTE_QUERY_MAX_TOKENS))).toBe('settings:terminal')
  })

  it('classifies exact, prefix, and token-score hits for cross-section leadership', () => {
    expect(rankMiddle('terminal settings')[0]).toMatchObject({
      id: 'settings:terminal',
      qualityClass: 'exact-intent'
    })
    expect(rankMiddle('new terminal settings')[0]).toMatchObject({
      id: 'settings:terminal',
      qualityClass: 'exact-intent'
    })
    expect(rankMiddle('appear')[0]).toMatchObject({
      id: 'settings:appearance',
      qualityClass: 'visible-prefix'
    })
    expect(rankMiddle('font term')[0]).toMatchObject({
      id: 'settings:terminal',
      qualityClass: 'partial-evidence'
    })
  })

  it('reports the strongest quality class in a section', () => {
    expect(bestCmdJPaletteSectionQualityClass([])).toBeNull()
    expect(bestCmdJPaletteSectionQualityClass(rankMiddle('terminal settings'))).toBe('exact-intent')
    expect(bestCmdJPaletteSectionQualityClass(rankMiddle('font term'))).toBe('partial-evidence')
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
  it('drops projects that only match the query through a generic alias word', () => {
    // Why: every project carries the 'repo'/'project' aliases, so "repo triage" used to
    // match all of them on that word alone — the same bug the middle band had.
    const search = (query: string): string[] =>
      searchCmdJProjectResults({
        query,
        projectGroups: [],
        repos: [repo('repo-1', 'linear-sync'), repo('repo-2', 'billing')],
        projects: [],
        projectHostSetups: []
      }).map((result) => result.title)

    expect(search('repo triage')).toEqual([])
    expect(search('linear triage')).toEqual([])
    expect(search('linear repo')).toEqual(['linear-sync'])
  })

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

  it('splits independent same-host checkouts of one project into per-setup keys', () => {
    // Why: two `cloned` checkouts share the project's remote identity but are
    // distinct user clones; the palette follows the sidebar and surfaces each as
    // its own jump target rather than collapsing them. See #5374.
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

  it('keeps a provisioned runtime copy under one project key alongside a same-host checkout', () => {
    // Why: a `provisioned` (recipe-created ephemeral) copy shares the project's
    // remote identity but must not split the user's real checkout; it nests
    // under the single project key. Mirrors the sidebar grouping. See #6320 / #5374.
    const results = searchCmdJProjectResults({
      query: 'platform',
      projectGroups: [],
      repos: [repo('repo-1', 'platform-a'), repo('repo-2', 'platform-runtime')],
      projects: [project('project-1', 'Platform')],
      projectHostSetups: [
        setup('setup-1', 'project-1', 'local', 'repo-1'),
        { ...setup('setup-2', 'project-1', 'local', 'repo-2'), setupMethod: 'provisioned' }
      ]
    })

    expect(results.map((result) => result.rowKey)).toEqual(['project:project-1'])
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

  it('rejects queries past the shared unique-token ceiling', () => {
    expect(
      searchCmdJProjectResults({
        query: overTokenLimitQuery,
        projectGroups: [projectGroup('group-1', 'Infrastructure')],
        repos: [repo('repo-1', 'linear-sync')],
        projects: [],
        projectHostSetups: []
      })
    ).toEqual([])
  })

  it('classifies exact, prefix, and token-score hits for cross-section leadership', () => {
    const search = (query: string): { title: string; qualityClass: string }[] =>
      searchCmdJProjectResults({
        query,
        projectGroups: [projectGroup('group-1', 'Infrastructure')],
        repos: [repo('repo-1', 'linear-sync')],
        projects: [],
        projectHostSetups: []
      }).map((result) => ({ title: result.title, qualityClass: result.qualityClass }))

    expect(search('infrastructure')[0]).toEqual({
      title: 'Infrastructure',
      qualityClass: 'exact-intent'
    })
    expect(search('infra')[0]).toEqual({ title: 'Infrastructure', qualityClass: 'visible-prefix' })
    // Why not exact-intent: 'repo' is a generic alias every project shares, so it
    // must not let the whole section outrank a named entity hit.
    expect(search('repo')[0]).toEqual({ title: 'linear-sync', qualityClass: 'visible-prefix' })
    expect(search('linear repo')[0]).toEqual({
      title: 'linear-sync',
      qualityClass: 'partial-evidence'
    })
  })
})
