import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  ACTIVITY_SEARCH_QUERY_MAX_BYTES,
  activityThreadResponseRenderPreview,
  activityThreadMatchesSearchQuery,
  buildActivityEvents,
  buildAgentPaneThreads,
  groupActivityThreadsByStatus,
  isActivitySearchQueryTooLarge
} from './ActivityPrototypePage'
import {
  makeActivityResult,
  makeRepo,
  makeRetainedDoneEntry,
  makeTab,
  makeTabWithIds,
  makeThreads,
  makeWorkingEntryWithPriorDone,
  makeWorkingEntryWithoutHistory,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2,
  PANE_KEY_3
} from './ActivityPrototypePage-test-fixtures'

describe('buildActivityEvents', () => {
  it('keeps every pane visible before applying the global activity cap', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tabs: TerminalTab[] = []
    const entries: Record<string, AgentStatusEntry> = {}

    for (let paneIndex = 0; paneIndex < 18; paneIndex += 1) {
      const tabId = `tab-${paneIndex}`
      const paneKey = makePaneKey(
        tabId,
        `00000000-0000-4000-8000-${String(paneIndex + 1).padStart(12, '0')}`
      )
      tabs.push(makeTabWithIds(tabId, worktree.id, `Agent ${paneIndex}`))
      // Why: later pane indexes are older, so the pre-fix global 80-event cap
      // would drop the final panes entirely when every pane had five events.
      const newestTimestamp = 100_000 - paneIndex * 1_000
      entries[paneKey] = {
        state: 'done',
        prompt: `Prompt ${paneIndex} current`,
        updatedAt: newestTimestamp,
        stateStartedAt: newestTimestamp,
        paneKey,
        terminalTitle: `Agent ${paneIndex}`,
        stateHistory: [1, 2, 3, 4].map((offset) => ({
          state: 'done',
          prompt: `Prompt ${paneIndex} history ${offset}`,
          startedAt: newestTimestamp - offset
        })),
        agentType: 'claude'
      }
    }

    const { events, liveAgentByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: entries,
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [worktree.id]: tabs },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 100_000
    })
    const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey })

    expect(events).toHaveLength(80)
    expect(threads).toHaveLength(18)
    expect(new Set(threads.map((thread) => thread.paneKey)).size).toBe(18)
  })

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

  it('does not turn a session boundary into an Agent finished event', () => {
    const result = makeActivityResult({
      entries: {
        [PANE_KEY]: {
          ...makeWorkingEntryWithoutHistory(),
          state: 'done',
          prompt: '',
          sessionBoundary: true,
          stateHistory: [{ state: 'done', prompt: 'Real turn', startedAt: 1_000 }]
        }
      }
    })

    // Why: the displaced real completion stays visible; the idle SessionStart does not add a second finish.
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ state: 'done', timestamp: 1_000 })
    expect(result.events[0].entry.prompt).toBe('Real turn')
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

  it('projects monitoring into thread rows and status groups', () => {
    const result = makeActivityResult({
      entries: {
        [PANE_KEY]: {
          ...makeWorkingEntryWithoutHistory(),
          workingMode: 'monitoring'
        }
      }
    })
    const threads = makeThreads(result)
    const groups = groupActivityThreadsByStatus(threads)

    expect(result.liveAgentByPaneKey[PANE_KEY].state).toBe('monitoring')
    expect(threads[0].currentAgentState).toBe('monitoring')
    expect(groups[0]).toMatchObject({
      id: 'monitoring',
      label: 'Monitoring background tasks',
      state: 'monitoring'
    })
  })

  it('uses orchestration display metadata for live thread titles', () => {
    const result = makeActivityResult({
      entries: {
        [PANE_KEY]: {
          ...makeWorkingEntryWithoutHistory(),
          prompt: 'You are working inside Orca, a multi-agent IDE.',
          orchestration: {
            taskId: 'task-1',
            dispatchId: 'ctx-1',
            taskTitle: 'Checkout race',
            displayName: 'Fix checkout race'
          }
        }
      }
    })

    const threads = makeThreads(result)

    expect(threads[0].paneTitle).toBe('Fix checkout race')
    expect(
      activityThreadMatchesSearchQuery({
        thread: threads[0],
        searchQuery: 'fix checkout race'
      })
    ).toBe(true)
    expect(
      activityThreadMatchesSearchQuery({
        thread: threads[0],
        searchQuery: 'multi-agent ide'
      })
    ).toBe(true)
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

  it('rejects oversized pasted searches before building thread search text', () => {
    const oversizedQuery = 'secret-activity-search'.repeat(ACTIVITY_SEARCH_QUERY_MAX_BYTES)
    const thread = {
      get paneTitle(): string {
        throw new Error('oversized activity searches must not scan thread text')
      }
    } as Parameters<typeof activityThreadMatchesSearchQuery>[0]['thread']

    expect(isActivitySearchQueryTooLarge(oversizedQuery)).toBe(true)
    expect(
      activityThreadMatchesSearchQuery({
        thread,
        searchQuery: oversizedQuery
      })
    ).toBe(false)
  })

  it('rejects oversized whitespace before trimming activity searches', () => {
    expect(
      activityThreadMatchesSearchQuery({
        thread: makeThreads(makeActivityResult({}))[0],
        searchQuery: ' '.repeat(ACTIVITY_SEARCH_QUERY_MAX_BYTES + 1)
      })
    ).toBe(false)
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

  it('groups visible threads with attention states before working and done', () => {
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

    expect(groups.map((group) => group.id)).toEqual(['blocked', 'working', 'done'])
    expect(groups.map((group) => group.threads.map((thread) => thread.paneKey))).toEqual([
      [PANE_KEY_2],
      [PANE_KEY],
      [PANE_KEY_3]
    ])
  })

  it('merges runtime orchestration context into activity events and entries', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab1 = makeTabWithIds('tab-1', worktree.id)
    const tab2 = makeTabWithIds('tab-2', worktree.id)
    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeWorkingEntryWithoutHistory(),
        [PANE_KEY_2]: {
          ...makeWorkingEntryWithoutHistory(),
          paneKey: PANE_KEY_2,
          terminalHandle: 'terminal-child'
        }
      },
      runtimeAgentOrchestrationByPaneKey: {
        [PANE_KEY_2]: {
          parentPaneKey: PANE_KEY,
          parentTerminalHandle: 'terminal-parent',
          taskId: 'task-counsel',
          dispatchId: 'ctx-counsel'
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [tab1, tab2]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 5_000
    })

    expect(result.liveAgentByPaneKey[PANE_KEY_2].entry.orchestration?.parentPaneKey).toBe(PANE_KEY)
    expect(result.liveAgentByPaneKey[PANE_KEY_2].entry.orchestration?.parentTerminalHandle).toBe(
      'terminal-parent'
    )
  })
})
