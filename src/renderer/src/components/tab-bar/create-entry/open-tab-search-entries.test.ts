import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  buildBrowserPage,
  buildWorkspaceFromPage
} from '@/store/slices/browser/pages/browser-page-records'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
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
    activeGroupIdByWorktree: {},
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
  it('omits the visible tab while keeping inactive and sibling-split tabs', () => {
    const state = baseState({
      tabsByWorktree: {
        [worktree.id]: ['active', 'inactive', 'sibling'].map((id) =>
          makeTab({ id: `term-${id}`, worktreeId: worktree.id, title: `Claude ${id}` })
        )
      },
      unifiedTabsByWorktree: {
        [worktree.id]: ['active', 'inactive', 'sibling'].map((id) =>
          makeUnifiedTab({
            id: `utab-${id}`,
            entityId: `term-${id}`,
            worktreeId: worktree.id,
            groupId: id === 'sibling' ? 'right' : 'left'
          })
        )
      }
    })

    const entries = buildOpenTabSearchEntries(state, agentState, new Map(), 'utab-active')
    expect(entries.workspaceTabs.map((entry) => entry.tab.id)).toEqual([
      'utab-inactive',
      'utab-sibling'
    ])

    // A paired-device browser row covers the real tab, so the strip excludes nothing.
    const covered = buildOpenTabSearchEntries(state, agentState, new Map(), null)
    expect(covered.workspaceTabs.map((entry) => entry.tab.id)).toEqual([
      'utab-active',
      'utab-inactive',
      'utab-sibling'
    ])
  })

  it('omits only the visible browser page, keeping background pages and other browser tabs', () => {
    const active = buildBrowserPage(
      'bws-1',
      worktree.id,
      'https://claude.ai',
      'Claude',
      undefined,
      'active'
    )
    const background = buildBrowserPage(
      'bws-1',
      worktree.id,
      'https://cloudflare.com',
      'Cloudflare',
      undefined,
      'background'
    )
    const other = buildBrowserPage(
      'bws-2',
      worktree.id,
      'https://cli.github.com',
      'GitHub CLI',
      undefined,
      'other'
    )
    const state = baseState({
      browserTabsByWorktree: {
        [worktree.id]: [
          buildWorkspaceFromPage('bws-1', worktree.id, active, [active.id, background.id]),
          buildWorkspaceFromPage('bws-2', worktree.id, other, [other.id])
        ]
      },
      browserPagesByWorkspace: { 'bws-1': [active, background], 'bws-2': [other] },
      unifiedTabsByWorktree: {
        [worktree.id]: ['bws-1', 'bws-2'].map((id) =>
          makeUnifiedTab({
            id: `utab-${id}`,
            entityId: id,
            worktreeId: worktree.id,
            groupId: 'left',
            contentType: 'browser'
          })
        )
      }
    })

    const entries = buildOpenTabSearchEntries(state, agentState, new Map(), 'utab-bws-1')
    expect(entries.browserPages.map((entry) => entry.page.id)).toEqual(['background', 'other'])
  })

  it('omits the visible simulator even without persisted groups', () => {
    const state = baseState({
      unifiedTabsByWorktree: {
        [worktree.id]: [
          makeUnifiedTab({
            id: 'sim',
            worktreeId: worktree.id,
            groupId: worktree.id,
            contentType: 'simulator'
          })
        ]
      }
    })

    expect(buildOpenTabSearchEntries(state, agentState, new Map(), 'sim').simulatorTabs).toEqual([])
  })
})
