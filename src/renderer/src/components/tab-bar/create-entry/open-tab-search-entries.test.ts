import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  buildBrowserPage,
  buildWorkspaceFromPage
} from '@/store/slices/browser/pages/browser-page-records'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import {
  buildOpenTabSearchEntries,
  selectOpenTabSearchAgentState,
  type OpenTabSearchEntryState
} from './open-tab-search-entries'

const worktree = makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: 'local' })
const agentState = selectOpenTabSearchAgentState(useAppStore.getState())

function baseState(overrides: Partial<OpenTabSearchEntryState>): OpenTabSearchEntryState {
  return {
    activeBrowserTabId: null,
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: { [worktree.id]: 'group-left' },
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: worktree.id,
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    executionHostId: 'local',
    folderWorkspaces: [],
    generatedTitlesEnabled: false,
    groupsByWorktree: {},
    openFiles: [],
    repo: { id: 'repo-1', displayName: 'orca', connectionId: undefined, executionHostId: 'local' },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    worktree,
    worktreesByRepo: { 'repo-1': [worktree] },
    ...overrides
  }
}

describe('buildOpenTabSearchEntries', () => {
  it('omits the active tab of the strip while keeping inactive and sibling-split tabs', () => {
    const state = baseState({
      activeTabId: 'term-active',
      tabsByWorktree: {
        [worktree.id]: [
          {
            id: 'term-active',
            worktreeId: worktree.id,
            ptyId: null,
            title: 'Claude recovery',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 'term-inactive',
            worktreeId: worktree.id,
            ptyId: null,
            title: 'Claude follow-up',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          },
          {
            id: 'term-sibling',
            worktreeId: worktree.id,
            ptyId: null,
            title: 'Claude sibling',
            customTitle: null,
            color: null,
            sortOrder: 2,
            createdAt: 2
          }
        ]
      },
      groupsByWorktree: {
        [worktree.id]: [
          {
            id: 'group-left',
            worktreeId: worktree.id,
            activeTabId: 'utab-active',
            tabOrder: ['utab-active', 'utab-inactive']
          },
          {
            id: 'group-right',
            worktreeId: worktree.id,
            activeTabId: 'utab-sibling',
            tabOrder: ['utab-sibling']
          }
        ]
      },
      unifiedTabsByWorktree: {
        [worktree.id]: [
          {
            id: 'utab-active',
            entityId: 'term-active',
            groupId: 'group-left',
            worktreeId: worktree.id,
            contentType: 'terminal',
            label: 'Claude recovery',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 'utab-inactive',
            entityId: 'term-inactive',
            groupId: 'group-left',
            worktreeId: worktree.id,
            contentType: 'terminal',
            label: 'Claude follow-up',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          },
          {
            id: 'utab-sibling',
            entityId: 'term-sibling',
            groupId: 'group-right',
            worktreeId: worktree.id,
            contentType: 'terminal',
            label: 'Claude sibling',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 2
          }
        ]
      }
    })

    const leftEntries = buildOpenTabSearchEntries(state, agentState, new Map(), {
      groupId: 'group-left'
    })
    expect(leftEntries.workspaceTabs.map((entry) => entry.tab.id)).toEqual([
      'utab-inactive',
      'utab-sibling'
    ])

    const clientHostedEntries = buildOpenTabSearchEntries(state, agentState, new Map(), {
      groupId: 'group-left',
      clientHostedRowActive: true
    })
    expect(clientHostedEntries.workspaceTabs.map((entry) => entry.tab.id)).toEqual([
      'utab-active',
      'utab-inactive',
      'utab-sibling'
    ])
  })

  it('omits only the active page of the strip active browser tab', () => {
    const activePage = buildBrowserPage(
      'bws-1',
      worktree.id,
      'https://claude.ai',
      'Claude',
      undefined,
      'page-active'
    )
    const backgroundPage = buildBrowserPage(
      'bws-1',
      worktree.id,
      'https://cloudflare.com',
      'Cloudflare',
      undefined,
      'page-background'
    )
    const otherTabPage = buildBrowserPage(
      'bws-2',
      worktree.id,
      'https://cli.github.com',
      'GitHub CLI',
      undefined,
      'page-other-tab'
    )
    const state = baseState({
      activeTabType: 'browser',
      activeBrowserTabId: 'bws-1',
      browserTabsByWorktree: {
        [worktree.id]: [
          buildWorkspaceFromPage('bws-1', worktree.id, activePage, [
            activePage.id,
            backgroundPage.id
          ]),
          buildWorkspaceFromPage('bws-2', worktree.id, otherTabPage, [otherTabPage.id])
        ]
      },
      browserPagesByWorkspace: {
        'bws-1': [activePage, backgroundPage],
        'bws-2': [otherTabPage]
      },
      groupsByWorktree: {
        [worktree.id]: [
          {
            id: 'group-left',
            worktreeId: worktree.id,
            activeTabId: 'utab-bws-1',
            tabOrder: ['utab-bws-1', 'utab-bws-2']
          }
        ]
      },
      unifiedTabsByWorktree: {
        [worktree.id]: [
          {
            id: 'utab-bws-1',
            entityId: 'bws-1',
            groupId: 'group-left',
            worktreeId: worktree.id,
            contentType: 'browser',
            label: 'Claude',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 'utab-bws-2',
            entityId: 'bws-2',
            groupId: 'group-left',
            worktreeId: worktree.id,
            contentType: 'browser',
            label: 'GitHub CLI',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      }
    })

    const entries = buildOpenTabSearchEntries(state, agentState, new Map(), {
      groupId: 'group-left'
    })
    expect(entries.browserPages.map((entry) => entry.page.id)).toEqual([
      'page-background',
      'page-other-tab'
    ])
  })
})
