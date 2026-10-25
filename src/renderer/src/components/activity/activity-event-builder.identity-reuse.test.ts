import { describe, expect, it, vi } from 'vitest'
import type {
  AgentStatusEntry,
  AgentStateHistoryEntry
} from '../../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  buildActivityEvents,
  createActivityEventBuildCache,
  newestActivityHistoryEntries
} from './activity-event-builder'
import type { ActivityEventBuildCache } from './activity-event-builder'
import { buildAgentPaneThreads, createAgentPaneThreadReuseCache } from './activity-thread-builder'
import type { AgentPaneThreadReuseCache } from './activity-thread-builder'
import {
  LEAF_ID,
  LEAF_ID_2,
  makeRepo,
  makeTab,
  makeTabWithIds,
  makeWorktree,
  PANE_KEY,
  makeWorkingEntryWithoutHistory
} from './ActivityPrototypePage-test-fixtures'
import { EVENTS_PER_PANE_CAP } from './activity-event-cap'
import type { Tab } from '../../../../shared/tab-types'

{
  const PANE_A = makePaneKey('tab-1', LEAF_ID)
  const PANE_B = makePaneKey('tab-2', LEAF_ID_2)
  const NOW = 100_000

  function entry(paneKey: string, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
    return {
      state: 'done',
      prompt: `run ${paneKey}`,
      updatedAt: 50_000,
      stateStartedAt: 50_000,
      paneKey,
      stateHistory: [{ state: 'done', prompt: 'older', startedAt: 10_000 }],
      agentType: 'claude',
      ...overrides
    }
  }

  type BuildArgs = Parameters<typeof buildActivityEvents>[0]

  function makeArgs(overrides: Partial<BuildArgs> = {}): BuildArgs {
    const repo = makeRepo()
    const worktree = makeWorktree()
    return {
      agentStatusByPaneKey: {
        [PANE_A]: entry(PANE_A),
        [PANE_B]: entry(PANE_B, { state: 'working', stateStartedAt: NOW - 1_000 })
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [makeTab(), makeTabWithIds('tab-2', worktree.id)]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: NOW,
      ...overrides
    }
  }

  function buildBoth(
    args: BuildArgs,
    eventCache: ActivityEventBuildCache,
    threadCache: AgentPaneThreadReuseCache
  ) {
    const result = buildActivityEvents(args, eventCache)
    const threads = buildAgentPaneThreads(
      { events: result.events, liveAgentByPaneKey: result.liveAgentByPaneKey },
      threadCache
    )
    return { ...result, threads }
  }

  function threadByPane<T extends { paneKey: string }>(
    threads: T[],
    paneKey: string
  ): T | undefined {
    return threads.find((thread) => thread.paneKey === paneKey)
  }

  describe('activity build identity reuse', () => {
    it('returns identical event, snapshot, thread, and list identities for identical inputs', () => {
      const eventCache = createActivityEventBuildCache()
      const threadCache = createAgentPaneThreadReuseCache()
      const args = makeArgs()
      const first = buildBoth(args, eventCache, threadCache)
      const second = buildBoth(args, eventCache, threadCache)

      expect(second.threads).toBe(first.threads)
      expect(second.events.map((event) => event)).toEqual(first.events.map((event) => event))
      for (let i = 0; i < first.events.length; i += 1) {
        expect(second.events[i]).toBe(first.events[i])
      }
      expect(second.liveAgentByPaneKey[PANE_B]).toBe(first.liveAgentByPaneKey[PANE_B])
    })

    it('changes only the written pane; every other thread keeps its identity', () => {
      const eventCache = createActivityEventBuildCache()
      const threadCache = createAgentPaneThreadReuseCache()
      const args = makeArgs()
      const first = buildBoth(args, eventCache, threadCache)

      const next = makeArgs({
        agentStatusByPaneKey: {
          ...args.agentStatusByPaneKey,
          [PANE_B]: entry(PANE_B, {
            state: 'working',
            stateStartedAt: NOW - 1_000,
            prompt: 'streamed update'
          })
        },
        tabsByWorktree: args.tabsByWorktree,
        worktreeMap: args.worktreeMap,
        repoMap: args.repoMap
      })
      const second = buildBoth(next, eventCache, threadCache)

      expect(threadByPane(second.threads, PANE_A)).toBe(threadByPane(first.threads, PANE_A))
      expect(threadByPane(second.threads, PANE_B)).not.toBe(threadByPane(first.threads, PANE_B))
      expect(second.threads).not.toBe(first.threads)
    })

    it('an acknowledgement or cleared-cutoff change rebuilds only that pane', () => {
      const eventCache = createActivityEventBuildCache()
      const threadCache = createAgentPaneThreadReuseCache()
      const args = makeArgs()
      const first = buildBoth(args, eventCache, threadCache)

      const acked = buildBoth(
        makeArgs({
          agentStatusByPaneKey: args.agentStatusByPaneKey,
          tabsByWorktree: args.tabsByWorktree,
          worktreeMap: args.worktreeMap,
          repoMap: args.repoMap,
          acknowledgedAgentsByPaneKey: { [PANE_A]: NOW }
        }),
        eventCache,
        threadCache
      )
      expect(threadByPane(acked.threads, PANE_B)).toBe(threadByPane(first.threads, PANE_B))
      expect(threadByPane(acked.threads, PANE_A)?.unread).toBe(false)
      expect(threadByPane(first.threads, PANE_A)?.unread).toBe(true)

      const cleared = buildBoth(
        makeArgs({
          agentStatusByPaneKey: args.agentStatusByPaneKey,
          tabsByWorktree: args.tabsByWorktree,
          worktreeMap: args.worktreeMap,
          repoMap: args.repoMap,
          acknowledgedAgentsByPaneKey: { [PANE_A]: NOW },
          activityClearedAtByPaneKey: { [PANE_A]: NOW }
        }),
        eventCache,
        threadCache
      )
      expect(threadByPane(cleared.threads, PANE_B)).toBe(threadByPane(first.threads, PANE_B))
      expect(threadByPane(cleared.threads, PANE_A)).toBeUndefined()
    })

    it('freshness decay refreshes the live snapshot without churning event identities', () => {
      const eventCache = createActivityEventBuildCache()
      const threadCache = createAgentPaneThreadReuseCache()
      const args = makeArgs()
      const first = buildBoth(args, eventCache, threadCache)
      expect(first.liveAgentByPaneKey[PANE_B]?.state).toBe('working')

      // Same inputs much later: the working turn is stale now, so the snapshot drops.
      const decayed = buildBoth(
        makeArgs({ ...args, now: NOW + 60 * 60 * 1000 }),
        eventCache,
        threadCache
      )
      expect(decayed.liveAgentByPaneKey[PANE_B]).toBeUndefined()
      expect(decayed.events.some((event) => event.state === 'working')).toBe(false)
      // PANE_A had no live snapshot; its thread survives untouched.
      expect(threadByPane(decayed.threads, PANE_A)).toBe(threadByPane(first.threads, PANE_A))
    })

    it('uses the same read receipt for working activity, heartbeats, and the next turn', () => {
      const eventCache = createActivityEventBuildCache()
      const threadCache = createAgentPaneThreadReuseCache()
      const args = makeArgs({
        agentStatusByPaneKey: {
          [PANE_B]: entry(PANE_B, {
            state: 'working',
            stateStartedAt: NOW - 1_000,
            updatedAt: NOW,
            stateHistory: []
          })
        }
      })
      const first = buildBoth(args, eventCache, threadCache)
      expect(first.events[0]).toMatchObject({ state: 'working', unread: true })
      expect(first.threads[0].unread).toBe(true)

      const readArgs = { ...args, acknowledgedAgentsByPaneKey: { [PANE_B]: NOW } }
      expect(buildBoth(readArgs, eventCache, threadCache).threads[0].unread).toBe(false)

      const heartbeatArgs = {
        ...readArgs,
        agentStatusByPaneKey: {
          [PANE_B]: { ...args.agentStatusByPaneKey[PANE_B], updatedAt: NOW + 1_000 }
        },
        now: NOW + 1_000
      }
      const heartbeat = buildBoth(heartbeatArgs, eventCache, threadCache)
      expect(heartbeat.events).toHaveLength(1)
      expect(heartbeat.events[0].id).toBe(first.events[0].id)
      expect(heartbeat.threads[0].unread).toBe(false)

      const next = buildBoth(
        {
          ...heartbeatArgs,
          agentStatusByPaneKey: {
            [PANE_B]: { ...heartbeatArgs.agentStatusByPaneKey[PANE_B], stateStartedAt: NOW + 1_000 }
          }
        },
        eventCache,
        threadCache
      )
      expect(next.events[0].id).not.toBe(first.events[0].id)
      expect(next.threads[0].unread).toBe(true)
    })

    it('cached builds always equal a cold uncached build (no drift)', () => {
      const eventCache = createActivityEventBuildCache()
      const threadCache = createAgentPaneThreadReuseCache()
      const scenarios: BuildArgs[] = [
        makeArgs(),
        makeArgs({ acknowledgedAgentsByPaneKey: { [PANE_A]: NOW } }),
        makeArgs({ activityClearedAtByPaneKey: { [PANE_A]: NOW } }),
        makeArgs({
          runtimeAgentOrchestrationByPaneKey: {
            [PANE_B]: { taskId: 't1', dispatchId: 'd1', parentPaneKey: PANE_A }
          }
        }),
        makeArgs({ now: NOW + 60 * 60 * 1000 })
      ]
      for (const scenario of scenarios) {
        const cached = buildBoth(scenario, eventCache, threadCache)
        const cold = buildActivityEvents(scenario)
        const coldThreads = buildAgentPaneThreads({
          events: cold.events,
          liveAgentByPaneKey: cold.liveAgentByPaneKey
        })
        expect(cached.events).toEqual(cold.events)
        expect(cached.liveAgentByPaneKey).toEqual(cold.liveAgentByPaneKey)
        expect(cached.threads).toEqual(coldThreads)
      }
    })

    it('keeps first-source-wins dedupe when a pane is both live and retained, and evicts gone panes', () => {
      const eventCache = createActivityEventBuildCache()
      const threadCache = createAgentPaneThreadReuseCache()
      const retained: RetainedAgentEntry = {
        entry: entry(PANE_A, { prompt: 'retained copy' }),
        worktreeId: makeWorktree().id,
        tab: makeTab(),
        agentType: 'claude',
        startedAt: 50_000
      }
      const args = makeArgs({ retainedAgentsByPaneKey: { [PANE_A]: retained } })
      const cachedResult = buildBoth(args, eventCache, threadCache)
      const cold = buildActivityEvents(args)
      expect(cachedResult.events).toEqual(cold.events)
      expect(eventCache.panes.has(`retained:${PANE_A}`)).toBe(true)

      // Retained entry dismissed: its cache row must not linger.
      buildBoth(makeArgs(), eventCache, threadCache)
      expect(eventCache.panes.has(`retained:${PANE_A}`)).toBe(false)
      expect(eventCache.panes.has(`live:${PANE_A}`)).toBe(true)
    })
  })
}

{
  function historyEntry(
    startedAt: number,
    state: AgentStateHistoryEntry['state']
  ): AgentStateHistoryEntry {
    return { state, prompt: `prompt-${startedAt}`, startedAt }
  }

  function build(args: {
    entries?: Record<string, AgentStatusEntry>
    activityClearedAtByPaneKey?: Record<string, number>
    now?: number
  }) {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTab()
    return buildActivityEvents({
      agentStatusByPaneKey: args.entries ?? {},
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [worktree.id]: [tab] },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      activityClearedAtByPaneKey: args.activityClearedAtByPaneKey,
      now: args.now ?? 100_000
    })
  }

  describe('newestActivityHistoryEntries', () => {
    it('takes only the newest cap-many eligible entries without scanning results past the cap', () => {
      const history: AgentStateHistoryEntry[] = []
      for (let i = 0; i < 10_000; i += 1) {
        history.push(historyEntry(i + 1, i % 2 === 0 ? 'done' : 'working'))
      }
      const newest = newestActivityHistoryEntries(history, EVENTS_PER_PANE_CAP)
      expect(newest).toHaveLength(EVENTS_PER_PANE_CAP)
      // Only done/blocked/waiting are eligible; newest five eligible are the last five even-indexed rows, oldest-first.
      expect(newest.map((entry) => entry.startedAt)).toEqual([9991, 9993, 9995, 9997, 9999])
    })

    it('returns fewer entries when eligible history is short', () => {
      const history = [historyEntry(1, 'working'), historyEntry(2, 'done')]
      expect(
        newestActivityHistoryEntries(history, EVENTS_PER_PANE_CAP).map((e) => e.startedAt)
      ).toEqual([2])
    })
  })

  describe('buildActivityEvents bounded history', () => {
    it('produces identical visible events for a pane with unbounded history as the per-pane cap allows', () => {
      const longHistory: AgentStateHistoryEntry[] = []
      for (let i = 0; i < 1_000; i += 1) {
        longHistory.push(historyEntry(i + 1, 'done'))
      }
      const entry: AgentStatusEntry = {
        state: 'done',
        prompt: 'latest',
        updatedAt: 5_000,
        stateStartedAt: 5_000,
        paneKey: PANE_KEY,
        stateHistory: longHistory,
        agentType: 'claude'
      }
      const { events } = build({ entries: { [PANE_KEY]: entry } })
      // Per-pane cap holds: newest events only, newest-first ordering preserved.
      expect(events).toHaveLength(EVENTS_PER_PANE_CAP)
      expect(events.map((event) => event.timestamp)).toEqual([5_000, 1_000, 999, 998, 997])
    })
  })

  describe('buildActivityEvents cleared cutoff', () => {
    const doneEntry: AgentStatusEntry = {
      state: 'done',
      prompt: 'finish it',
      updatedAt: 2_000,
      stateStartedAt: 2_000,
      paneKey: PANE_KEY,
      stateHistory: [historyEntry(1_000, 'done')],
      agentType: 'claude'
    }

    it('hides events stamped at or before the pane cutoff', () => {
      const { events } = build({
        entries: { [PANE_KEY]: doneEntry },
        activityClearedAtByPaneKey: { [PANE_KEY]: 2_000 }
      })
      expect(events).toHaveLength(0)
    })

    it('keeps events newer than the cutoff', () => {
      const { events } = build({
        entries: { [PANE_KEY]: doneEntry },
        activityClearedAtByPaneKey: { [PANE_KEY]: 1_000 }
      })
      expect(events.map((event) => event.timestamp)).toEqual([2_000])
    })

    it('does not suppress a live working snapshot for a cleared pane', () => {
      const workingEntry: AgentStatusEntry = {
        ...doneEntry,
        state: 'working',
        updatedAt: 99_000,
        stateStartedAt: 99_000
      }
      const { events, liveAgentByPaneKey } = build({
        entries: { [PANE_KEY]: workingEntry },
        activityClearedAtByPaneKey: { [PANE_KEY]: 98_000 },
        now: 99_500
      })
      expect(liveAgentByPaneKey[PANE_KEY]?.state).toBe('working')
      // The historical done at 1_000 stays hidden by the cutoff.
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ state: 'working', timestamp: 99_000, unread: true })
    })
  })
}

{
  describe('live activity capacity', () => {
    it('preserves completed rows and unread live turns beyond the history budget', () => {
      const repo = makeRepo()
      const worktree = makeWorktree()
      const tabs = Array.from({ length: 82 }, (_, i) => makeTabWithIds(`tab-${i}`, worktree.id))
      const entries = Object.fromEntries(
        tabs.map((tab, i) => {
          const paneKey = makePaneKey(tab.id, LEAF_ID)
          return [
            paneKey,
            {
              paneKey,
              state: i === 0 ? 'done' : 'working',
              prompt: `Task ${i}`,
              stateStartedAt: i === 0 ? 1_000 : 2_000 + i,
              updatedAt: 3_000,
              stateHistory: [],
              agentType: 'claude'
            } satisfies AgentStatusEntry
          ]
        })
      )
      const result = buildActivityEvents({
        agentStatusByPaneKey: entries,
        retainedAgentsByPaneKey: {},
        tabsByWorktree: { [worktree.id]: tabs },
        worktreeMap: new Map([[worktree.id, worktree]]),
        repoMap: new Map([[repo.id, repo]]),
        acknowledgedAgentsByPaneKey: {},
        now: 3_000
      })
      const threads = buildAgentPaneThreads(result)

      expect(threads).toHaveLength(82)
      expect(
        threads.find((thread) => thread.paneKey === makePaneKey(tabs[0].id, LEAF_ID))
      ).toMatchObject({ latestEvent: { state: 'done' }, unread: true })
      const workingThreads = threads.filter((thread) => thread.currentAgentState === 'working')
      expect(workingThreads).toHaveLength(81)
      expect(workingThreads.every((thread) => thread.unread)).toBe(true)
    })
  })
}

{
  function build(args: {
    entry: AgentStatusEntry
    unifiedTabs?: Tab[]
  }): ReturnType<typeof buildActivityEvents> {
    const repo = makeRepo()
    const worktree = makeWorktree()
    return buildActivityEvents({
      agentStatusByPaneKey: { [PANE_KEY]: args.entry },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [worktree.id]: [] },
      unifiedTabsByWorktree: { [worktree.id]: args.unifiedTabs ?? [] },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })
  }

  describe('activity event agent contexts', () => {
    it('builds a live thread context from a unified structured-agent tab', () => {
      const structuredTab = {
        id: 'tab-1',
        entityId: 'session-1',
        groupId: 'group-1',
        worktreeId: 'wt-1',
        executionHostId: 'local',
        contentType: 'agent-session',
        label: 'Codex chat',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        agentSessionAgent: 'codex'
      } satisfies Tab

      const result = build({
        entry: makeWorkingEntryWithoutHistory(),
        unifiedTabs: [structuredTab]
      })

      expect(result.liveAgentByPaneKey[PANE_KEY]).toMatchObject({
        state: 'working',
        worktree: { id: 'wt-1' },
        tab: { id: 'tab-1', ptyId: null, title: 'Codex chat' }
      })
    })

    it('uses direct worktree attribution before an agent tab reaches the renderer', () => {
      const result = build({
        entry: {
          ...makeWorkingEntryWithoutHistory(),
          worktreeId: 'wt-1'
        }
      })

      expect(result.liveAgentByPaneKey[PANE_KEY]).toMatchObject({
        state: 'working',
        worktree: { id: 'wt-1' },
        tab: { id: 'tab-1', worktreeId: 'wt-1', ptyId: null }
      })
    })

    it('preserves a unified structured session remote-runtime owner', () => {
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
      const structuredTab = {
        id: 'tab-1',
        entityId: 'session-1',
        groupId: 'group-1',
        worktreeId: 'wt-1',
        executionHostId: 'runtime:env-1',
        contentType: 'agent-session',
        label: 'Remote Codex chat',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        agentSessionAgent: 'codex'
      } satisfies Tab
      const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
        executionHostId === 'runtime:env-1' ? runtimeWorktree : localWorktree
      )

      const result = buildActivityEvents({
        agentStatusByPaneKey: {
          [PANE_KEY]: { ...makeWorkingEntryWithoutHistory(), connectionId: null }
        },
        retainedAgentsByPaneKey: {},
        tabsByWorktree: { [localWorktree.id]: [] },
        unifiedTabsByWorktree: { [localWorktree.id]: [structuredTab] },
        worktreeMap: new Map([[localWorktree.id, localWorktree]]),
        repoMap: new Map([[localRepo.id, localRepo]]),
        repos: [localRepo, runtimeRepo],
        resolveWorktree,
        acknowledgedAgentsByPaneKey: {},
        now: 3_000
      })

      expect(resolveWorktree).toHaveBeenCalledWith('wt-1', 'runtime:env-1')
      expect(result.liveAgentByPaneKey[PANE_KEY]?.worktree).toBe(runtimeWorktree)
      expect(result.liveAgentByPaneKey[PANE_KEY]?.repo).toBe(runtimeRepo)
    })

    it('preserves an early worktree-attributed SSH owner before its tab arrives', () => {
      const localRepo = makeRepo()
      const remoteRepo = {
        ...makeRepo(),
        connectionId: 'builder',
        displayName: 'SSH repo'
      }
      const localWorktree = makeWorktree()
      const remoteWorktree = {
        ...makeWorktree(),
        hostId: 'ssh:builder' as const,
        displayName: 'SSH worktree'
      }
      const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
        executionHostId === 'ssh:builder' ? remoteWorktree : localWorktree
      )

      const result = buildActivityEvents({
        agentStatusByPaneKey: {
          [PANE_KEY]: {
            ...makeWorkingEntryWithoutHistory(),
            worktreeId: 'wt-1',
            connectionId: 'builder'
          }
        },
        retainedAgentsByPaneKey: {},
        tabsByWorktree: { [localWorktree.id]: [] },
        worktreeMap: new Map([[localWorktree.id, localWorktree]]),
        repoMap: new Map([[localRepo.id, localRepo]]),
        repos: [localRepo, remoteRepo],
        resolveWorktree,
        acknowledgedAgentsByPaneKey: {},
        now: 3_000
      })

      expect(resolveWorktree).toHaveBeenCalledWith('wt-1', 'ssh:builder')
      expect(result.liveAgentByPaneKey[PANE_KEY]?.worktree).toBe(remoteWorktree)
      expect(result.liveAgentByPaneKey[PANE_KEY]?.repo).toBe(remoteRepo)
    })
  })
}
