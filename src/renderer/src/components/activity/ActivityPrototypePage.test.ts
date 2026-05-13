import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  activityThreadMatchesSearchQuery,
  buildActivityEvents,
  buildAgentPaneThreads
} from './ActivityPrototypePage'

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
  }
}

function makeWorktree(): Worktree {
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

function makeTab(): TerminalTab {
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

function makeWorkingEntryWithPriorDone(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'Second prompt',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    paneKey: 'tab-1:1',
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

function makeWorkingEntryWithoutHistory(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'New run',
    updatedAt: 3_000,
    stateStartedAt: 3_000,
    paneKey: 'tab-1:1',
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude'
  }
}

function makeRetainedDoneEntry(tab: TerminalTab): RetainedAgentEntry {
  return {
    entry: {
      state: 'done',
      prompt: 'Retained prior run',
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      paneKey: 'tab-1:1',
      terminalTitle: 'Claude',
      stateHistory: [],
      agentType: 'claude'
    },
    worktreeId: 'wt-1',
    tab,
    agentType: 'claude',
    startedAt: 1_000
  }
}

describe('buildActivityEvents', () => {
  it('keeps a prior done event after the same pane starts working again', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTab()

    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-1:1': makeWorkingEntryWithPriorDone()
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [tab]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 2_000
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      state: 'done',
      timestamp: 1_000
    })
    expect(result.events[0].entry.prompt).toBe('First prompt')
    expect(result.liveAgentByPaneKey['tab-1:1'].state).toBe('working')
    expect(result.liveAgentByPaneKey['tab-1:1'].entry.prompt).toBe('Second prompt')

    const threads = buildAgentPaneThreads({
      events: result.events,
      liveAgentByPaneKey: result.liveAgentByPaneKey
    })

    expect(threads).toHaveLength(1)
    expect(threads[0].paneTitle).toBe('Second prompt')
    expect(threads[0].latestTimestamp).toBe(2_000)
    expect(threads[0].events[0].entry.prompt).toBe('First prompt')
  })

  it('does not keep showing a stale live agent as running', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTab()

    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-1:1': makeWorkingEntryWithPriorDone()
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [tab]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 2_000 + AGENT_STATUS_STALE_AFTER_MS + 1
    })

    expect(result.events).toHaveLength(1)
    expect(result.liveAgentByPaneKey['tab-1:1']).toBeUndefined()
  })

  it('creates a thread for a fresh running agent with no historical events', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTab()

    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-1:1': makeWorkingEntryWithoutHistory()
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [tab]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    const threads = buildAgentPaneThreads({
      events: result.events,
      liveAgentByPaneKey: result.liveAgentByPaneKey
    })

    expect(result.events).toHaveLength(0)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      paneKey: 'tab-1:1',
      paneTitle: 'New run',
      currentAgentState: 'working',
      latestTimestamp: 3_000,
      latestEvent: null,
      unread: false
    })
  })

  it('matches a custom-titled live thread by its current prompt', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = { ...makeTab(), customTitle: 'Pinned agent title' }
    const entry = {
      ...makeWorkingEntryWithoutHistory(),
      prompt: 'Investigate activity live prompt search'
    }

    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-1:1': entry
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [tab]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    const threads = buildAgentPaneThreads({
      events: result.events,
      liveAgentByPaneKey: result.liveAgentByPaneKey
    })

    expect(threads[0].paneTitle).toBe('Pinned agent title')
    expect(
      activityThreadMatchesSearchQuery({
        thread: threads[0],
        searchQuery: 'live prompt search'
      })
    ).toBe(true)
  })

  it('overlays fresh live state onto retained-only activity for a reused pane key', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTab()

    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-1:1': makeWorkingEntryWithoutHistory()
      },
      retainedAgentsByPaneKey: {
        'tab-1:1': makeRetainedDoneEntry(tab)
      },
      tabsByWorktree: {
        [worktree.id]: [tab]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      state: 'done',
      timestamp: 1_000
    })
    expect(result.events[0].entry.prompt).toBe('Retained prior run')
    expect(result.liveAgentByPaneKey['tab-1:1'].state).toBe('working')

    const threads = buildAgentPaneThreads({
      events: result.events,
      liveAgentByPaneKey: result.liveAgentByPaneKey
    })

    expect(threads).toHaveLength(1)
    expect(threads[0].paneTitle).toBe('New run')
    expect(threads[0].latestTimestamp).toBe(3_000)
    expect(threads[0].events[0].entry.prompt).toBe('Retained prior run')
  })
})
