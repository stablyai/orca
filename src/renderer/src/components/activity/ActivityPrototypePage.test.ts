/* eslint-disable max-lines -- Activity feed builders share realistic fixture
coverage in one file so status grouping stays tied to the event/thread adapter. */
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  activityThreadResponseRenderPreview,
  activityThreadMatchesSearchQuery,
  buildActivityThreadGroups,
  buildActivityEvents,
  buildAgentPaneThreads,
  getActivityThreadGroup,
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

function makeWorktreeWithId(id: string, repoId = 'repo-1', displayName = id): Worktree {
  return {
    ...makeWorktree(),
    id,
    repoId,
    path: `/repo/${id}`,
    displayName
  }
}

function makeTabWithIds(id: string, worktreeId: string, title = id): TerminalTab {
  return {
    ...makeTab(),
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title
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

describe('activity thread grouping', () => {
  it('status grouping separates interrupted done from normal done and keeps Interrupted label', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab1 = makeTabWithIds('tab-1', worktree.id)
    const tab2 = makeTabWithIds('tab-2', worktree.id)
    const sharedDone: Omit<
      AgentStatusEntry,
      'paneKey' | 'interrupted' | 'updatedAt' | 'stateStartedAt'
    > = {
      state: 'done',
      prompt: 'Prompt',
      terminalTitle: 'Claude',
      stateHistory: [],
      agentType: 'claude'
    }
    const { events, liveAgentByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-1:1': {
          ...sharedDone,
          paneKey: 'tab-1:1',
          interrupted: true,
          updatedAt: 3_000,
          stateStartedAt: 3_000
        },
        'tab-2:1': {
          ...sharedDone,
          paneKey: 'tab-2:1',
          interrupted: false,
          updatedAt: 2_000,
          stateStartedAt: 2_000
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [worktree.id]: [tab1, tab2] },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })
    const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey })
    const groups = buildActivityThreadGroups(threads, 'status')

    expect(groups).toHaveLength(2)
    expect(groups[0].key).toBe('done:interrupted')
    expect(groups[0].label).toBe('Interrupted')
    expect(groups[1].key).toBe('done')
    expect(groups[1].label).toBe('Done')
  })

  it('project grouping falls back to unknown project when repo is missing', () => {
    const worktree = makeWorktreeWithId('wt-unknown', 'missing-repo', 'unknown-wt')
    const tab = makeTabWithIds('tab-unknown', worktree.id)
    const { events, liveAgentByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-unknown:1': {
          state: 'done',
          prompt: 'Prompt',
          updatedAt: 1_000,
          stateStartedAt: 1_000,
          paneKey: 'tab-unknown:1',
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [worktree.id]: [tab] },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map(),
      acknowledgedAgentsByPaneKey: {},
      now: 1_000
    })
    const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey })
    const group = getActivityThreadGroup(threads[0], 'project')

    expect(group).toEqual({ key: 'project:unknown', label: 'Unknown project' })
  })

  it('worktree and agent grouping use expected keys and labels', () => {
    const result = makeActivityResult({
      entries: {
        'tab-1:1': makeWorkingEntryWithoutHistory()
      }
    })
    const threads = makeThreads(result)

    expect(getActivityThreadGroup(threads[0], 'worktree')).toEqual({
      key: 'worktree:wt-1',
      label: 'feature'
    })
    expect(getActivityThreadGroup(threads[0], 'agent')).toEqual({
      key: 'agent:claude',
      label: formatAgentTypeLabel('claude')
    })
  })

  it('keeps first-appearance group order and preserves intra-group thread order', () => {
    const repo = makeRepo()
    const wtA = makeWorktreeWithId('wt-a', repo.id, 'alpha')
    const wtB = makeWorktreeWithId('wt-b', repo.id, 'beta')
    const tabA1 = makeTabWithIds('tab-a1', wtA.id)
    const tabB1 = makeTabWithIds('tab-b1', wtB.id)
    const tabA2 = makeTabWithIds('tab-a2', wtA.id)
    const { events, liveAgentByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-a1:1': {
          state: 'done',
          prompt: 'A1',
          updatedAt: 3_000,
          stateStartedAt: 3_000,
          paneKey: 'tab-a1:1',
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        },
        'tab-b1:1': {
          state: 'done',
          prompt: 'B1',
          updatedAt: 2_000,
          stateStartedAt: 2_000,
          paneKey: 'tab-b1:1',
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        },
        'tab-a2:1': {
          state: 'done',
          prompt: 'A2',
          updatedAt: 1_000,
          stateStartedAt: 1_000,
          paneKey: 'tab-a2:1',
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [wtA.id]: [tabA1, tabA2], [wtB.id]: [tabB1] },
      worktreeMap: new Map([
        [wtA.id, wtA],
        [wtB.id, wtB]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })
    const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey })
    const groups = buildActivityThreadGroups(threads, 'worktree')

    expect(groups.map((group) => group.key)).toEqual(['worktree:wt-a', 'worktree:wt-b'])
    expect(groups[0].threads.map((thread) => thread.paneKey)).toEqual(['tab-a1:1', 'tab-a2:1'])
    expect(groups[1].threads.map((thread) => thread.paneKey)).toEqual(['tab-b1:1'])
  })

  it('returns no groups for empty thread input', () => {
    expect(buildActivityThreadGroups([], 'status')).toEqual([])
  })
})
