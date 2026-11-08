import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import './workspace/search/tabs/workspace-tab-search-types'
import { buildOpenTabSearchEntries } from '../components/tab-bar/open-tab-search-entries'

const SHARED_WORKTREE_ID = 'repo-shared::/workspace'

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
  it('keeps hidden same-id hosts in the legacy ownership ambiguity set', () => {
    const ownershipWorktrees = pairedWorktrees()
    const browserWorkspace = makeBrowserWorkspace('legacy-browser')
    const unifiedTabsByWorktree = {
      [SHARED_WORKTREE_ID]: [
        makeTab({
          id: 'legacy-browser-tab',
          entityId: browserWorkspace.id,
          contentType: 'browser',
          executionHostId: undefined
        }),
        makeTab({ id: 'legacy-simulator', contentType: 'simulator', executionHostId: undefined }),
        makeTab({ id: 'legacy-terminal', entityId: 'legacy-terminal', executionHostId: undefined })
      ]
    }
    const entries = buildOpenTabSearchEntries(
      {
        activeBrowserTabId: null,
        activeFileId: null,
        activeFileIdByWorktree: {},
        activeGroupIdByWorktree: {},
        activeTabId: null,
        activeTabIdByWorktree: {},
        activeTabType: 'terminal',
        activeTabTypeByWorktree: {},
        activeWorktreeId: null,
        browserPagesByWorkspace: {
          [browserWorkspace.id]: [makeBrowserPage(browserWorkspace)]
        },
        browserTabsByWorktree: { [SHARED_WORKTREE_ID]: [browserWorkspace] },
        executionHostId: 'local',
        generatedTitlesEnabled: true,
        groupsByWorktree: {},
        openFiles: [],
        folderWorkspaces: [],
        repo: null,
        tabsByWorktree: {
          [SHARED_WORKTREE_ID]: [
            {
              id: 'legacy-terminal',
              ptyId: 'legacy-pty',
              worktreeId: SHARED_WORKTREE_ID,
              title: 'Legacy shell',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        unifiedTabsByWorktree,
        worktree: ownershipWorktrees[0],
        worktreesByRepo: { repo: ownershipWorktrees }
      },
      {
        agentStatusByPaneKey: {},
        paneForegroundAgentByPaneKey: {},
        retainedAgentsByPaneKey: {},
        sleepingAgentSessionsByPaneKey: {},
        terminalLayoutsByTabId: {}
      },
      new Map()
    )

    expect(entries).toEqual({
      browserPages: [],
      simulatorTabs: [],
      workspaceTabs: []
    })
  })
})
