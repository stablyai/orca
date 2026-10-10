import { describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  ACTIVITY_SEARCH_QUERY_MAX_BYTES,
  activityThreadMatchesSearchQuery,
  buildActivityThreadGroups,
  isActivitySearchQueryTooLarge
} from './activity-thread-grouping'
import {
  activityThreadResponseRenderPreview,
  activityThreadStatusId
} from './activity-thread-presentation'
import { buildActivityEvents } from './activity-event-builder'
import { buildAgentPaneThreads } from './activity-thread-builder'
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
  PANE_KEY_3,
  LEAF_ID
} from './ActivityPrototypePage-test-fixtures'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

{
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

      expect(result.events).toHaveLength(2)
      expect(result.events[0]).toMatchObject({ state: 'working', timestamp: 2_000 })
      expect(result.events[1]).toMatchObject({
        state: 'done',
        timestamp: 1_000
      })
      expect(result.events[1].entry.prompt).toBe('First prompt')
      expect(result.liveAgentByPaneKey[PANE_KEY].state).toBe('working')
      expect(result.liveAgentByPaneKey[PANE_KEY].entry.prompt).toBe('Second prompt')

      const threads = makeThreads(result)

      expect(threads).toHaveLength(1)
      expect(threads[0].paneTitle).toBe('Second prompt')
      expect(threads[0].latestTimestamp).toBe(2_000)
      expect(threads[0].events[1].entry.prompt).toBe('First prompt')
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
      // The pane's own row is still `working`, but only a fresh turn may say so.
      expect(activityThreadStatusId(makeThreads(result)[0])).toBe('done')
    })

    it('creates a thread for a fresh running agent with no historical events', () => {
      const result = makeActivityResult({
        entries: {
          [PANE_KEY]: makeWorkingEntryWithoutHistory()
        }
      })

      const threads = makeThreads(result)

      expect(result.events).toHaveLength(1)
      expect(threads).toHaveLength(1)
      expect(threads[0]).toMatchObject({
        paneKey: PANE_KEY,
        paneTitle: 'New run',
        currentAgentState: 'working',
        latestTimestamp: 3_000,
        latestEvent: { state: 'working', timestamp: 3_000 },
        unread: true
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
      const groups = buildActivityThreadGroups(threads, 'status')

      expect(result.liveAgentByPaneKey[PANE_KEY].state).toBe('monitoring')
      expect(threads[0].currentAgentState).toBe('monitoring')
      // A monitoring turn must not emit a `working` event that contradicts the live snapshot.
      expect(result.events).toHaveLength(0)
      expect(threads[0].latestEvent).toBeNull()
      expect(groups[0]).toMatchObject({
        key: 'monitoring',
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

      expect(result.events).toHaveLength(1)
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

      expect(result.events).toHaveLength(2)
      expect(result.events[1]).toMatchObject({
        state: 'done',
        timestamp: 1_000
      })
      expect(result.events[1].entry.prompt).toBe('Retained prior run')
      expect(result.liveAgentByPaneKey[PANE_KEY].state).toBe('working')

      const threads = makeThreads(result)

      expect(threads).toHaveLength(1)
      expect(threads[0].paneTitle).toBe('New run')
      expect(threads[0].responsePreview).toBe('')
      expect(threads[0].latestTimestamp).toBe(3_000)
      expect(threads[0].events[1].entry.prompt).toBe('Retained prior run')
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

      const groups = buildActivityThreadGroups(
        buildAgentPaneThreads({
          events: result.events,
          liveAgentByPaneKey: result.liveAgentByPaneKey
        }),
        'status'
      )

      expect(groups.map((group) => group.key)).toEqual(['blocked', 'working', 'done'])
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

      expect(result.liveAgentByPaneKey[PANE_KEY_2].entry.orchestration?.parentPaneKey).toBe(
        PANE_KEY
      )
      expect(result.liveAgentByPaneKey[PANE_KEY_2].entry.orchestration?.parentTerminalHandle).toBe(
        'terminal-parent'
      )
    })
  })
}

{
  const PANE_KEY = `tab-1:${LEAF_ID}`

  function doneEntry(connectionId: string | null): AgentStatusEntry {
    return {
      state: 'done',
      prompt: 'Finished task',
      updatedAt: 2_000,
      stateStartedAt: 2_000,
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      connectionId,
      stateHistory: [],
      agentType: 'claude'
    }
  }

  describe('activity event host ownership', () => {
    it('uses the status transport host when worktree and repo ids collide', () => {
      const localRepo = makeRepo()
      const remoteRepo = { ...makeRepo(), connectionId: 'builder', displayName: 'Remote repo' }
      const localWorktree = makeWorktree()
      const remoteWorktree = {
        ...makeWorktree(),
        hostId: 'ssh:builder' as const,
        displayName: 'Remote worktree'
      }
      const tab = makeTab()
      const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
        executionHostId === 'ssh:builder' ? remoteWorktree : localWorktree
      )

      const result = buildActivityEvents({
        agentStatusByPaneKey: { [PANE_KEY]: doneEntry('builder') },
        retainedAgentsByPaneKey: {},
        tabsByWorktree: { [localWorktree.id]: [tab] },
        worktreeMap: new Map([[localWorktree.id, localWorktree]]),
        repoMap: new Map([[localRepo.id, localRepo]]),
        repos: [localRepo, remoteRepo],
        resolveWorktree,
        acknowledgedAgentsByPaneKey: {},
        now: 3_000
      })

      expect(resolveWorktree).toHaveBeenCalledWith(localWorktree.id, 'ssh:builder')
      expect(result.events[0]?.worktree).toBe(remoteWorktree)
      expect(result.events[0]?.repo).toBe(remoteRepo)
    })

    it('uses the mirrored tab host when paired-runtime status is host-local', () => {
      const localRepo = makeRepo()
      const runtimeRepo = {
        ...makeRepo(),
        executionHostId: 'runtime:env-1' as const,
        displayName: 'Runtime repo'
      }
      const localWorktree = makeWorktree()
      const runtimeWorktree = {
        ...makeWorktree(),
        hostId: 'runtime:env-1' as const,
        runtimeOwnerEnvironmentId: 'env-1',
        displayName: 'Runtime worktree'
      }
      const tab = makeTab()
      const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
        executionHostId === 'runtime:env-1' ? runtimeWorktree : localWorktree
      )

      const result = buildActivityEvents({
        agentStatusByPaneKey: { [PANE_KEY]: doneEntry(null) },
        retainedAgentsByPaneKey: {},
        tabsByWorktree: { [localWorktree.id]: [tab] },
        unifiedTabsByWorktree: {
          [localWorktree.id]: [
            {
              id: tab.id,
              entityId: tab.id,
              groupId: 'group-1',
              worktreeId: localWorktree.id,
              executionHostId: 'runtime:env-1',
              contentType: 'terminal',
              label: tab.title,
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        worktreeMap: new Map([[localWorktree.id, localWorktree]]),
        repoMap: new Map([[localRepo.id, localRepo]]),
        repos: [localRepo, runtimeRepo],
        resolveWorktree,
        acknowledgedAgentsByPaneKey: {},
        now: 3_000
      })

      expect(resolveWorktree).toHaveBeenCalledWith(localWorktree.id, 'runtime:env-1')
      expect(result.events[0]?.worktree).toBe(runtimeWorktree)
      expect(result.events[0]?.repo).toBe(runtimeRepo)
    })

    it('keeps retained folder-workspace activity after its terminal tab is gone', () => {
      const folderWorktree = {
        ...makeWorktree(),
        id: folderWorkspaceKey('folder-1'),
        repoId: 'folder-workspace:group-1',
        hostId: 'local' as const,
        displayName: 'Docs folder'
      }
      const tab = { ...makeTab(), worktreeId: folderWorktree.id }
      const retained = makeRetainedDoneEntry(tab)
      retained.worktreeId = folderWorktree.id
      retained.entry = doneEntry(null)

      const result = buildActivityEvents({
        agentStatusByPaneKey: {},
        retainedAgentsByPaneKey: { [PANE_KEY]: retained },
        tabsByWorktree: {},
        worktreeMap: new Map(),
        repoMap: new Map(),
        resolveWorktree: (worktreeId, executionHostId) =>
          worktreeId === folderWorktree.id && executionHostId === 'local'
            ? folderWorktree
            : undefined,
        acknowledgedAgentsByPaneKey: {},
        now: 3_000
      })

      expect(result.events[0]?.worktree).toBe(folderWorktree)
      expect(result.events[0]?.worktree.displayName).toBe('Docs folder')
    })

    it('carries migrationUnsupportedPtyId on events built for un-migratable panes', () => {
      const worktree = makeWorktree()
      const repo = makeRepo()
      const tab = makeTab()

      const result = buildActivityEvents({
        agentStatusByPaneKey: {},
        retainedAgentsByPaneKey: {},
        migrationUnsupportedByPtyId: {
          'pty-1': {
            ptyId: 'pty-1',
            paneKey: PANE_KEY,
            tabId: tab.id,
            reason: 'legacy-numeric-pane-key',
            source: 'local',
            updatedAt: 1_000
          }
        },
        tabsByWorktree: { [worktree.id]: [tab] },
        worktreeMap: new Map([[worktree.id, worktree]]),
        repoMap: new Map([[repo.id, repo]]),
        resolveWorktree: () => worktree,
        acknowledgedAgentsByPaneKey: {},
        now: 3_000
      })

      expect(result.events.length).toBeGreaterThan(0)
      for (const event of result.events) {
        expect(event.migrationUnsupportedPtyId).toBe('pty-1')
      }
    })

    it('uses the retained terminal handle to preserve runtime host ownership after teardown', () => {
      const localWorktree = makeWorktree()
      const runtimeWorktree = {
        ...makeWorktree(),
        hostId: 'runtime:env-1' as const,
        runtimeOwnerEnvironmentId: 'env-1',
        displayName: 'Runtime worktree'
      }
      const tab = { ...makeTab(), ptyId: null }
      const retained = makeRetainedDoneEntry(tab)
      retained.entry = { ...doneEntry(null), terminalHandle: 'remote:env-1@@pty-1' }
      const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
        executionHostId === 'runtime:env-1' ? runtimeWorktree : localWorktree
      )

      const result = buildActivityEvents({
        agentStatusByPaneKey: {},
        retainedAgentsByPaneKey: { [PANE_KEY]: retained },
        tabsByWorktree: {},
        worktreeMap: new Map([[localWorktree.id, localWorktree]]),
        repoMap: new Map(),
        resolveWorktree,
        acknowledgedAgentsByPaneKey: {},
        now: 3_000
      })

      expect(resolveWorktree).toHaveBeenCalledWith(localWorktree.id, 'runtime:env-1')
      expect(result.events[0]?.worktree).toBe(runtimeWorktree)
    })
  })
}
