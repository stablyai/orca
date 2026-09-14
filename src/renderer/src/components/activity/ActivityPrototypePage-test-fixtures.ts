import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { buildActivityEvents, buildAgentPaneThreads } from './ActivityPrototypePage'

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'
export const LEAF_ID_3 = '33333333-3333-4333-8333-333333333333'
export const LEAF_ID_UNKNOWN = '44444444-4444-4444-8444-444444444444'
export const LEAF_ID_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
export const LEAF_ID_B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
export const LEAF_ID_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
export const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
export const PANE_KEY_2 = makePaneKey('tab-2', LEAF_ID_2)
export const PANE_KEY_3 = makePaneKey('tab-3', LEAF_ID_3)
export const UNKNOWN_PANE_KEY = makePaneKey('tab-unknown', LEAF_ID_UNKNOWN)
export const PANE_KEY_A1 = makePaneKey('tab-a1', LEAF_ID_A1)
export const PANE_KEY_B1 = makePaneKey('tab-b1', LEAF_ID_B1)
export const PANE_KEY_A2 = makePaneKey('tab-a2', LEAF_ID_A2)

export function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
  }
}

export function makeWorktree(): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

export function makeTab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

export function makeWorktreeWithId(id: string, repoId = 'repo-1', displayName = id): Worktree {
  return {
    ...makeWorktree(),
    id,
    repoId,
    path: `/repo/${id}`,
    displayName
  }
}

export function makeTabWithIds(id: string, worktreeId: string, title = id): TerminalTab {
  return {
    ...makeTab(),
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title
  }
}

export function makeWorkingEntryWithPriorDone(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'Second prompt',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    paneKey: PANE_KEY,
    terminalTitle: 'Claude',
    stateHistory: [
      {
        state: 'done',
        prompt: 'First prompt',
        startedAt: 1_000
      }
    ],
    agentType: 'claude'
  }
}

export function makeWorkingEntryWithoutHistory(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'New run',
    updatedAt: 3_000,
    stateStartedAt: 3_000,
    paneKey: PANE_KEY,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude'
  }
}

export function makeRetainedDoneEntry(tab: TerminalTab): RetainedAgentEntry {
  return {
    entry: {
      state: 'done',
      prompt: 'Retained prior run',
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      paneKey: PANE_KEY,
      terminalTitle: 'Claude',
      stateHistory: [],
      agentType: 'claude',
      lastAssistantMessage: 'Retained response preview'
    },
    worktreeId: 'wt-1',
    tab,
    agentType: 'claude',
    startedAt: 1_000
  }
}

export function makeActivityResult(args: {
  entries?: Record<string, AgentStatusEntry>
  retained?: Record<string, RetainedAgentEntry>
  tab?: TerminalTab
  now?: number
}): ReturnType<typeof buildActivityEvents> {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const tab = args.tab ?? makeTab()

  return buildActivityEvents({
    agentStatusByPaneKey: args.entries ?? {},
    retainedAgentsByPaneKey: args.retained ?? {},
    tabsByWorktree: {
      [worktree.id]: [tab]
    },
    worktreeMap: new Map([[worktree.id, worktree]]),
    repoMap: new Map([[repo.id, repo]]),
    acknowledgedAgentsByPaneKey: {},
    now: args.now ?? 3_000
  })
}

export function makeThreads(result: ReturnType<typeof buildActivityEvents>) {
  return buildAgentPaneThreads({
    events: result.events,
    liveAgentByPaneKey: result.liveAgentByPaneKey
  })
}
