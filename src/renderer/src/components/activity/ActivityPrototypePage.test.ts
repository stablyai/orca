/* eslint-disable max-lines -- Activity feed builders share realistic fixture
coverage in one file so status grouping stays tied to the event/thread adapter. */
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
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
import { makePaneKey } from '../../../../shared/stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_ID_3 = '33333333-3333-4333-8333-333333333333'
const LEAF_ID_UNKNOWN = '44444444-4444-4444-8444-444444444444'
const LEAF_ID_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const LEAF_ID_B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const LEAF_ID_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const PANE_KEY_2 = makePaneKey('tab-2', LEAF_ID_2)
const PANE_KEY_3 = makePaneKey('tab-3', LEAF_ID_3)
const UNKNOWN_PANE_KEY = makePaneKey('tab-unknown', LEAF_ID_UNKNOWN)
const PANE_KEY_A1 = makePaneKey('tab-a1', LEAF_ID_A1)
const PANE_KEY_B1 = makePaneKey('tab-b1', LEAF_ID_B1)
const PANE_KEY_A2 = makePaneKey('tab-a2', LEAF_ID_A2)

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

function makeWorkingEntryWithoutHistory(): AgentStatusEntry {
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

function makeRetainedDoneEntry(tab: TerminalTab): RetainedAgentEntry {
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
        [PANE_KEY]: makeWorkingEntryWithPriorDone()
      },
      now: 2_000
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      state: 'done',
      timestamp: 1_000
    })
    expect(result.events[0].entry.prompt).toBe('First prompt')
    expect(result.liveAgentByPaneKey[PANE_KEY].state).toBe('working')
    expect(result.liveAgentByPaneKey[PANE_KEY].entry.prompt).toBe('Second prompt')

    const threads = makeThreads(result)

    expect(threads).toHaveLength(1)
    expect(threads[0].paneTitle).toBe('Second prompt')
    expect(threads[0].latestTimestamp).toBe(2_000)
    expect(threads[0].events[0].entry.prompt).toBe('First prompt')
  })

  it('does not keep showing a stale live agent as running', () => {
    const result = makeActivityResult({
      entries: {
        [PANE_KEY]: makeWorkingEntryWithPriorDone()
      },
      now: 2_000 + AGENT_STATUS_STALE_AFTER_MS + 1
    })

    expect(result.events).toHaveLength(1)
    expect(result.liveAgentByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('creates a thread for a fresh running agent with no historical events', () => {
    const result = makeActivityResult({
      entries: {
        [PANE_KEY]: makeWorkingEntryWithoutHistory()
      }
    })

    const threads = makeThreads(result)

    expect(result.events).toHaveLength(0)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      paneKey: PANE_KEY,
      paneTitle: 'New run',
      currentAgentState: 'working',
      latestTimestamp: 3_000,
      latestEvent: null,
      unread: false
    })
  })

  it('creates a thread for a repo-less floating terminal agent', () => {
    const tab = makeTabWithIds('tab-1', FLOATING_TERMINAL_WORKTREE_ID, 'Claude')
    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeWorkingEntryWithoutHistory()
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [tab]
      },
      worktreeMap: new Map(),
      repoMap: new Map(),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    const threads = makeThreads(result)

    expect(result.events).toHaveLength(0)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      paneKey: PANE_KEY,
      paneTitle: 'New run',
      currentAgentState: 'working',
      repo: null
    })
    expect(threads[0].worktree).toMatchObject({
      id: FLOATING_TERMINAL_WORKTREE_ID,
      displayName: 'Floating terminal'
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
        [PANE_KEY]: entry
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
        [PANE_KEY]: entry
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
        [PANE_KEY]: entry
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
        [PANE_KEY]: makeRetainedDoneEntry(tab)
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
        [PANE_KEY]: makeWorkingEntryWithoutHistory()
      },
      retained: {
        [PANE_KEY]: makeRetainedDoneEntry(tab)
      },
      tab
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      state: 'done',
      timestamp: 1_000
    })
    expect(result.events[0].entry.prompt).toBe('Retained prior run')
    expect(result.liveAgentByPaneKey[PANE_KEY].state).toBe('working')

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
        [PANE_KEY]: makeWorkingEntryWithoutHistory(),
        [PANE_KEY_2]: {
          ...makeWorkingEntryWithoutHistory(),
          state: 'blocked',
          prompt: 'Needs approval',
          updatedAt: 4_000,
          stateStartedAt: 4_000,
          paneKey: PANE_KEY_2
        },
        [PANE_KEY_3]: {
          ...makeWorkingEntryWithoutHistory(),
          state: 'done',
          prompt: 'Finished work',
          updatedAt: 5_000,
          stateStartedAt: 5_000,
          paneKey: PANE_KEY_3
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
      [PANE_KEY],
      [PANE_KEY_2],
      [PANE_KEY_3]
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
        [PANE_KEY]: {
          ...sharedDone,
          paneKey: PANE_KEY,
          interrupted: true,
          updatedAt: 3_000,
          stateStartedAt: 3_000
        },
        [PANE_KEY_2]: {
          ...sharedDone,
          paneKey: PANE_KEY_2,
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
        [UNKNOWN_PANE_KEY]: {
          state: 'done',
          prompt: 'Prompt',
          updatedAt: 1_000,
          stateStartedAt: 1_000,
          paneKey: UNKNOWN_PANE_KEY,
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
        [PANE_KEY]: makeWorkingEntryWithoutHistory()
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
        [PANE_KEY_A1]: {
          state: 'done',
          prompt: 'A1',
          updatedAt: 3_000,
          stateStartedAt: 3_000,
          paneKey: PANE_KEY_A1,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        },
        [PANE_KEY_B1]: {
          state: 'done',
          prompt: 'B1',
          updatedAt: 2_000,
          stateStartedAt: 2_000,
          paneKey: PANE_KEY_B1,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        },
        [PANE_KEY_A2]: {
          state: 'done',
          prompt: 'A2',
          updatedAt: 1_000,
          stateStartedAt: 1_000,
          paneKey: PANE_KEY_A2,
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
    expect(groups[0].threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_A1, PANE_KEY_A2])
    expect(groups[1].threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_B1])
  })

  it('returns no groups for empty thread input', () => {
    expect(buildActivityThreadGroups([], 'status')).toEqual([])
  })
})
