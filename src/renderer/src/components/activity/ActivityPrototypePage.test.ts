/* eslint-disable max-lines -- Activity feed builders share realistic fixture
coverage in one file so status grouping stays tied to the event/thread adapter. */
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  activityThreadResponseRenderPreview,
  activityThreadMatchesSearchQuery,
  buildActivityEvents,
  buildAgentPaneThreads,
  groupActivityThreadsByStatus
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
      agentType: 'claude',
      lastAssistantMessage: 'Retained response preview'
    },
    worktreeId: 'wt-1',
    tab,
    agentType: 'claude',
    startedAt: 1_000
  }
}

function makeActivityResult(args: {
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

function makeThreads(result: ReturnType<typeof buildActivityEvents>) {
  return buildAgentPaneThreads({
    events: result.events,
    liveAgentByPaneKey: result.liveAgentByPaneKey
  })
}

describe('buildActivityEvents', () => {
  it('keeps a prior done event after the same pane starts working again', () => {
    const result = makeActivityResult({
      entries: {
        'tab-1:1': makeWorkingEntryWithPriorDone()
      },
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

    const threads = makeThreads(result)

    expect(threads).toHaveLength(1)
    expect(threads[0].paneTitle).toBe('Second prompt')
    expect(threads[0].latestTimestamp).toBe(2_000)
    expect(threads[0].events[0].entry.prompt).toBe('First prompt')
  })

  it('does not keep showing a stale live agent as running', () => {
    const result = makeActivityResult({
      entries: {
        'tab-1:1': makeWorkingEntryWithPriorDone()
      },
      now: 2_000 + AGENT_STATUS_STALE_AFTER_MS + 1
    })

    expect(result.events).toHaveLength(1)
    expect(result.liveAgentByPaneKey['tab-1:1']).toBeUndefined()
  })

  it('creates a thread for a fresh running agent with no historical events', () => {
    const result = makeActivityResult({
      entries: {
        'tab-1:1': makeWorkingEntryWithoutHistory()
      }
    })

    const threads = makeThreads(result)

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
    const tab = { ...makeTab(), customTitle: 'Pinned agent title' }
    const entry = {
      ...makeWorkingEntryWithoutHistory(),
      prompt: 'Investigate activity live prompt search'
    }

    const result = makeActivityResult({
      entries: {
        'tab-1:1': entry
      },
      tab
    })

    const threads = makeThreads(result)

    expect(threads[0].paneTitle).toBe('Pinned agent title')
    expect(
      activityThreadMatchesSearchQuery({
        thread: threads[0],
        searchQuery: 'live prompt search'
      })
    ).toBe(true)
  })

  it('surfaces the current live assistant response as the thread preview', () => {
    const entry = {
      ...makeWorkingEntryWithoutHistory(),
      lastAssistantMessage: 'I updated the tests and checked the activity row.'
    }

    const result = makeActivityResult({
      entries: {
        'tab-1:1': entry
      }
    })

    const threads = makeThreads(result)

    expect(threads[0].responsePreview).toBe('I updated the tests and checked the activity row.')
    expect(
      activityThreadMatchesSearchQuery({
        thread: threads[0],
        searchQuery: 'checked the activity row'
      })
    ).toBe(true)
  })

  it('caps rendered assistant response preview without changing searchable thread text', () => {
    const longResponse = `${'Preview details '.repeat(80)}activity row searchable tail`
    const entry = {
      ...makeWorkingEntryWithoutHistory(),
      lastAssistantMessage: longResponse
    }

    const result = makeActivityResult({
      entries: {
        'tab-1:1': entry
      }
    })

    const threads = makeThreads(result)
    const renderedPreview = activityThreadResponseRenderPreview({
      responsePreview: threads[0].responsePreview
    })

    expect(renderedPreview.length).toBeLessThan(longResponse.length)
    expect(renderedPreview.endsWith('...')).toBe(true)
    expect(
      activityThreadMatchesSearchQuery({
        thread: threads[0],
        searchQuery: 'searchable tail'
      })
    ).toBe(true)
  })

  it('does not leave a lone surrogate when capping the rendered response preview', () => {
    const renderedPreview = activityThreadResponseRenderPreview({
      responsePreview: `${'a'.repeat(319)}😀tail`
    })
    const beforeEllipsis = renderedPreview.slice(0, -3)
    const lastCode = beforeEllipsis.charCodeAt(beforeEllipsis.length - 1)

    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false)
  })

  it('surfaces the retained done assistant response as the thread preview', () => {
    const tab = makeTab()

    const result = makeActivityResult({
      retained: {
        'tab-1:1': makeRetainedDoneEntry(tab)
      },
      tab
    })

    const threads = makeThreads(result)

    expect(threads[0].responsePreview).toBe('Retained response preview')
  })

  it('overlays fresh live state onto retained-only activity for a reused pane key', () => {
    const tab = makeTab()

    const result = makeActivityResult({
      entries: {
        'tab-1:1': makeWorkingEntryWithoutHistory()
      },
      retained: {
        'tab-1:1': makeRetainedDoneEntry(tab)
      },
      tab
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      state: 'done',
      timestamp: 1_000
    })
    expect(result.events[0].entry.prompt).toBe('Retained prior run')
    expect(result.liveAgentByPaneKey['tab-1:1'].state).toBe('working')

    const threads = makeThreads(result)

    expect(threads).toHaveLength(1)
    expect(threads[0].paneTitle).toBe('New run')
    expect(threads[0].responsePreview).toBe('')
    expect(threads[0].latestTimestamp).toBe(3_000)
    expect(threads[0].events[0].entry.prompt).toBe('Retained prior run')
  })

  it('groups visible threads by current status order', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const workingTab = makeTab()
    const blockedTab = { ...makeTab(), id: 'tab-2', ptyId: 'pty-2' }
    const doneTab = { ...makeTab(), id: 'tab-3', ptyId: 'pty-3' }
    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-1:1': makeWorkingEntryWithoutHistory(),
        'tab-2:1': {
          ...makeWorkingEntryWithoutHistory(),
          state: 'blocked',
          prompt: 'Needs approval',
          updatedAt: 4_000,
          stateStartedAt: 4_000,
          paneKey: 'tab-2:1'
        },
        'tab-3:1': {
          ...makeWorkingEntryWithoutHistory(),
          state: 'done',
          prompt: 'Finished work',
          updatedAt: 5_000,
          stateStartedAt: 5_000,
          paneKey: 'tab-3:1'
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [workingTab, blockedTab, doneTab]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 5_000
    })

    const groups = groupActivityThreadsByStatus(
      buildAgentPaneThreads({
        events: result.events,
        liveAgentByPaneKey: result.liveAgentByPaneKey
      })
    )

    expect(groups.map((group) => group.id)).toEqual(['working', 'blocked', 'done'])
    expect(groups.map((group) => group.threads.map((thread) => thread.paneKey))).toEqual([
      ['tab-1:1'],
      ['tab-2:1'],
      ['tab-3:1']
    ])
  })
})
