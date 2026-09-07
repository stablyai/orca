import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  buildActivityEvents,
  createActivityEventBuildCache,
  type ActivityEventBuildCache
} from './activity-event-builder'
import {
  buildAgentPaneThreads,
  createAgentPaneThreadReuseCache,
  type AgentPaneThreadReuseCache
} from './activity-thread-builder'
import {
  LEAF_ID,
  LEAF_ID_2,
  makeRepo,
  makeTab,
  makeTabWithIds,
  makeWorktree
} from './ActivityPrototypePage-test-fixtures'

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

function threadByPane<T extends { paneKey: string }>(threads: T[], paneKey: string): T | undefined {
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
    // PANE_A had no live snapshot; its thread survives untouched.
    expect(threadByPane(decayed.threads, PANE_A)).toBe(threadByPane(first.threads, PANE_A))
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
