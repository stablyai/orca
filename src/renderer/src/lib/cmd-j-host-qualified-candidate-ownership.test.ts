import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { buildSearchableBrowserPages } from './browser-palette-page-entries'
import { searchBrowserPages } from './browser-palette-search'
import { buildSearchableSimulatorTabs, searchSimulatorTabs } from './simulator-palette-search'
import { buildSearchableWorkspaceTabs, searchWorkspaceTabs } from './workspace-tab-palette-search'

const SHARED_WORKTREE_ID = 'repo-shared::/workspace'
const RUNTIME_HOST_ID = 'runtime:paired-host'

function makeWorktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: SHARED_WORKTREE_ID,
    repoId: 'repo-shared',
    path: '/workspace',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeTab(overrides: Partial<Tab>): Tab {
  return {
    id: 'tab',
    entityId: 'entity',
    groupId: 'group',
    worktreeId: SHARED_WORKTREE_ID,
    contentType: 'terminal',
    label: 'Tab',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function makeBrowserWorkspace(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: SHARED_WORKTREE_ID,
    activePageId: `${id}-page`,
    pageIds: [`${id}-page`],
    url: `https://${id}.example.test`,
    title: `${id} docs`,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function makeBrowserPage(workspace: BrowserWorkspace): BrowserPage {
  return {
    id: `${workspace.id}-page`,
    workspaceId: workspace.id,
    worktreeId: SHARED_WORKTREE_ID,
    url: workspace.url,
    title: workspace.title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function pairedWorktrees(): Worktree[] {
  return [
    makeWorktree({ hostId: 'local', displayName: 'Local workspace' }),
    makeWorktree({
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'paired-host',
      displayName: 'Paired SSH workspace'
    })
  ]
}

describe('Cmd-J host-qualified candidate ownership', () => {
  it('keeps browser rows owned by a paired runtime over SSH', () => {
    const [local, remote] = pairedWorktrees()
    const localWorkspace = makeBrowserWorkspace('local-browser')
    const remoteWorkspace = makeBrowserWorkspace('remote-browser')
    const entries = buildSearchableBrowserPages({
      worktrees: [local, remote],
      repoMap: new Map(),
      worktreeOrder: new Map(),
      browserTabsByWorktree: {
        [SHARED_WORKTREE_ID]: [localWorkspace, remoteWorkspace]
      },
      browserPagesByWorkspace: {
        [localWorkspace.id]: [makeBrowserPage(localWorkspace)],
        [remoteWorkspace.id]: [makeBrowserPage(remoteWorkspace)]
      },
      unifiedTabsByWorktree: {
        [SHARED_WORKTREE_ID]: [
          makeTab({
            id: 'local-browser-tab',
            entityId: localWorkspace.id,
            contentType: 'browser',
            executionHostId: 'local'
          }),
          makeTab({
            id: 'remote-browser-tab',
            entityId: remoteWorkspace.id,
            contentType: 'browser',
            executionHostId: RUNTIME_HOST_ID
          })
        ]
      },
      activeBrowserTabId: null,
      activeWorktreeId: null,
      activeTabType: 'terminal'
    })

    expect(
      searchBrowserPages(entries, 'docs').map((result) => [
        result.workspaceId,
        result.executionHostId
      ])
    ).toEqual([
      [localWorkspace.id, 'local'],
      [remoteWorkspace.id, RUNTIME_HOST_ID]
    ])
  })

  it('keeps simulator rows owned by a paired runtime over SSH', () => {
    const entries = buildSearchableSimulatorTabs({
      worktrees: pairedWorktrees(),
      repoMap: new Map(),
      worktreeOrder: new Map(),
      unifiedTabsByWorktree: {
        [SHARED_WORKTREE_ID]: [
          makeTab({
            id: 'local-simulator',
            entityId: 'local-simulator',
            contentType: 'simulator',
            executionHostId: 'local',
            label: 'Local emulator'
          }),
          makeTab({
            id: 'remote-simulator',
            entityId: 'remote-simulator',
            contentType: 'simulator',
            executionHostId: RUNTIME_HOST_ID,
            label: 'Remote emulator'
          })
        ]
      },
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      activeWorktreeId: null,
      activeTabType: 'terminal'
    })

    expect(
      searchSimulatorTabs(entries, 'emulator').map((result) => [
        result.tabId,
        result.executionHostId
      ])
    ).toEqual([
      ['local-simulator', 'local'],
      ['remote-simulator', RUNTIME_HOST_ID]
    ])
  })

  it('keeps generic workspace rows isolated by execution host', () => {
    const terminalTabs: TerminalTab[] = [
      {
        id: 'local-terminal',
        ptyId: 'local-pty',
        worktreeId: SHARED_WORKTREE_ID,
        title: 'Local shell',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      },
      {
        id: 'remote-terminal',
        ptyId: 'remote-pty',
        worktreeId: SHARED_WORKTREE_ID,
        title: 'Remote shell',
        customTitle: null,
        color: null,
        sortOrder: 1,
        createdAt: 1
      }
    ]
    const entries = buildSearchableWorkspaceTabs({
      worktrees: pairedWorktrees(),
      repoMap: new Map(),
      worktreeOrder: new Map(),
      unifiedTabsByWorktree: {
        [SHARED_WORKTREE_ID]: [
          makeTab({
            id: 'local-terminal',
            entityId: 'local-terminal',
            executionHostId: 'local',
            label: 'Local shell'
          }),
          makeTab({
            id: 'remote-terminal',
            entityId: 'remote-terminal',
            executionHostId: RUNTIME_HOST_ID,
            label: 'Remote shell'
          })
        ]
      },
      tabsByWorktree: { [SHARED_WORKTREE_ID]: terminalTabs },
      openFiles: [],
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      activeWorktreeId: null,
      activeTabType: 'terminal',
      activeTabId: null,
      activeTabIdByWorktree: {},
      activeFileId: null,
      activeFileIdByWorktree: {},
      activeTabTypeByWorktree: {},
      generatedTitlesEnabled: true
    })

    expect(
      searchWorkspaceTabs(entries, 'shell').map((result) => [result.tabId, result.executionHostId])
    ).toEqual([
      ['local-terminal', 'local'],
      ['remote-terminal', RUNTIME_HOST_ID]
    ])
  })

  it('retains one unambiguous legacy tab without guessing between sibling hosts', () => {
    const legacyWorktree = makeWorktree({ hostId: undefined })
    const entries = buildSearchableSimulatorTabs({
      worktrees: [legacyWorktree],
      repoMap: new Map(),
      worktreeOrder: new Map(),
      unifiedTabsByWorktree: {
        [SHARED_WORKTREE_ID]: [
          makeTab({ id: 'legacy-simulator', contentType: 'simulator', executionHostId: undefined })
        ]
      },
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      activeWorktreeId: null,
      activeTabType: 'terminal'
    })

    expect(entries.map((entry) => entry.tab.id)).toEqual(['legacy-simulator'])
  })
})
