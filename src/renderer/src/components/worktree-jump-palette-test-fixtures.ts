import type { Repo } from '../../../shared/repo-types'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { AppState } from '@/store/types'

// Store fixtures shared by the Cmd+J palette suites (worktree list + recent chats & terminals).

export function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repos/repo-1',
    displayName: 'Repo 1',
    badgeColor: '#000000',
    addedAt: 0
  }
}

export function makeWorktree(
  id: string,
  displayName: string,
  overrides: Partial<Worktree> = {}
): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName,
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

export function makeTerminalTab(id: string, worktreeId: string, title: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

export function makeUnifiedTab(
  id: string,
  worktreeId: string,
  entityId: string,
  label: string
): Tab {
  return {
    id,
    entityId,
    groupId: `group-${worktreeId}`,
    worktreeId,
    contentType: 'terminal',
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

export function makeGroup(worktreeId: string, tabIds: string[]): TabGroup {
  return {
    id: `group-${worktreeId}`,
    worktreeId,
    activeTabId: tabIds[0] ?? null,
    tabOrder: tabIds,
    recentTabIds: tabIds
  }
}

export const LEAF_ID = '11111111-2222-4333-8444-555555555555'

export function makeAgentEntry(
  tabId: string,
  state: AgentStatusState,
  stateStartedAt: number,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: stateStartedAt,
    stateStartedAt,
    paneKey: makePaneKey(tabId, LEAF_ID),
    stateHistory: [],
    ...overrides
  }
}

/** Two worktrees, one terminal tab each, none of them current. */
export function makeRecentTabState(overrides: Partial<AppState> = {}): Partial<AppState> {
  const alpha = makeWorktree('wt-alpha', 'Alpha workspace')
  const beta = makeWorktree('wt-beta', 'Beta workspace')
  return {
    worktreesByRepo: { 'repo-1': [alpha, beta] },
    showSleepingWorkspaces: true,
    ptyIdsByTabId: {
      'term-alpha': ['pty-term-alpha'],
      'term-beta': ['pty-term-beta']
    },
    tabsByWorktree: {
      'wt-alpha': [makeTerminalTab('term-alpha', 'wt-alpha', 'Alpha chat')],
      'wt-beta': [makeTerminalTab('term-beta', 'wt-beta', 'Beta chat')]
    },
    unifiedTabsByWorktree: {
      'wt-alpha': [makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat')],
      'wt-beta': [makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'Beta chat')]
    },
    groupsByWorktree: {
      'wt-alpha': [makeGroup('wt-alpha', ['tab-alpha'])],
      'wt-beta': [makeGroup('wt-beta', ['tab-beta'])]
    },
    activeGroupIdByWorktree: {
      'wt-alpha': 'group-wt-alpha',
      'wt-beta': 'group-wt-beta'
    },
    ...overrides
  }
}

/** Two host-qualified worktrees intentionally publish the same unified tab id. */
export function makeDuplicateRecentTabState(): Partial<AppState> {
  const alpha = makeWorktree('wt-alpha', 'Alpha workspace', { hostId: 'ssh:alpha' })
  const beta = makeWorktree('wt-beta', 'Beta workspace', { hostId: 'ssh:beta' })
  return {
    worktreesByRepo: { 'repo-1': [alpha, beta] },
    showSleepingWorkspaces: true,
    ptyIdsByTabId: {
      'term-alpha': ['pty-term-alpha'],
      'term-beta': ['pty-term-beta']
    },
    tabsByWorktree: {
      'wt-alpha': [makeTerminalTab('term-alpha', 'wt-alpha', 'Alpha duplicate')],
      'wt-beta': [makeTerminalTab('term-beta', 'wt-beta', 'Beta duplicate')]
    },
    unifiedTabsByWorktree: {
      'wt-alpha': [makeUnifiedTab('tab-duplicate', 'wt-alpha', 'term-alpha', 'Alpha duplicate')],
      'wt-beta': [makeUnifiedTab('tab-duplicate', 'wt-beta', 'term-beta', 'Beta duplicate')]
    },
    groupsByWorktree: {
      'wt-alpha': [makeGroup('wt-alpha', ['tab-duplicate'])],
      'wt-beta': [makeGroup('wt-beta', ['tab-duplicate'])]
    },
    activeGroupIdByWorktree: {
      'wt-alpha': 'group-wt-alpha',
      'wt-beta': 'group-wt-beta'
    }
  }
}

/** One tab-heavy worktree plus `count` bare ones, so both sections overflow their caps. */
export function makeManyTabState(count: number): Partial<AppState> {
  const ids = Array.from({ length: count }, (_, index) => `${index}`)
  return {
    worktreesByRepo: {
      'repo-1': [
        makeWorktree('wt-many', 'Many workspace'),
        ...ids.map((id) => makeWorktree(`wt-${id}`, `Spare workspace ${id}`))
      ]
    },
    showSleepingWorkspaces: true,
    ptyIdsByTabId: Object.fromEntries(ids.map((id) => [`term-${id}`, [`pty-${id}`]])),
    tabsByWorktree: {
      'wt-many': ids.map((id) => makeTerminalTab(`term-${id}`, 'wt-many', `Chat ${id}`))
    },
    unifiedTabsByWorktree: {
      'wt-many': ids.map((id) => makeUnifiedTab(`tab-${id}`, 'wt-many', `term-${id}`, `Chat ${id}`))
    },
    groupsByWorktree: {
      'wt-many': [
        makeGroup(
          'wt-many',
          ids.map((id) => `tab-${id}`)
        )
      ]
    },
    activeGroupIdByWorktree: { 'wt-many': 'group-wt-many' }
  }
}
