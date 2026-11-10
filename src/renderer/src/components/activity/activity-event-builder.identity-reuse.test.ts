import * as paneBuilds from './activity-event-build-cache'
import type { Worktree } from '../../../../shared/worktree/types'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStateHistoryEntry } from '../../../../shared/agent-status/lifecycle/agent-state-history'

import { classifyChildAgents } from './activity-thread-child-agent'
import { buildAgentPaneThreads } from './activity-thread-builder'
import { createActivityEventBuildCache } from './activity-event-build-cache'
import { buildActivityEvents } from './activity-event-builder'

import {
  makeRepo,
  makeTab,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2,
  PANE_KEY_3
} from './ActivityPrototypePage-test-fixtures'

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
    sleeping?: ReadonlyMap<string, AgentStatusEntry>
  }) {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTab()
    return buildActivityEvents({
      chatNames: new Map(),
      agentStatusByPaneKey: args.entries ?? {},
      sleepingAgentStatusByPaneKey: args.sleeping,

      tabsByWorktree: { [worktree.id]: [tab] },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      activityClearedAtByPaneKey: args.activityClearedAtByPaneKey,
      now: args.now ?? 100_000
    })
  }

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

    it('shows an aged real slept completion as a passive thread with its original event', () => {
      const entry = { ...doneEntry, stateHistory: [] }
      const result = build({
        sleeping: new Map([[PANE_KEY, entry]]),
        now: 2_000_000
      })
      expect(result.events.map((event) => event.timestamp)).toEqual([2_000])
      expect(result.liveAgentByPaneKey[PANE_KEY]).toBeUndefined()
      expect(result.passiveAgentByPaneKey[PANE_KEY]?.entry).toBe(entry)
    })

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
  })
}

it('keeps eventless sleeping child lineage current across context replacement and removal', () => {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const cache = createActivityEventBuildCache()
  const sleep = (paneKey: string): AgentStatusEntry => ({
    paneKey,
    state: 'done',
    sessionBoundary: true,
    stateStartedAt: 100,
    updatedAt: 100,
    prompt: 'slept',
    agentType: 'claude',
    stateHistory: []
  })
  const sleeping = new Map([PANE_KEY, PANE_KEY_2, PANE_KEY_3].map((key) => [key, sleep(key)]))
  for (const parent of [PANE_KEY, PANE_KEY_3, undefined]) {
    const built = buildActivityEvents(
      {
        chatNames: new Map(),
        agentStatusByPaneKey: {},
        sleepingAgentStatusByPaneKey: sleeping,
        tabsByWorktree: {
          [worktree.id]: ['tab-1', 'tab-2', 'tab-3'].map((id) => ({ ...makeTab(), id }))
        },
        worktreeMap: new Map([[worktree.id, worktree]]),
        repoMap: new Map([[repo.id, repo]]),
        acknowledgedAgentsByPaneKey: {},
        now: 1000,
        runtimeAgentOrchestrationByPaneKey: parent
          ? {
              [PANE_KEY_2]: { parentPaneKey: parent, taskId: 'task', dispatchId: 'dispatch' }
            }
          : {}
      },
      cache
    )
    const threads = buildAgentPaneThreads(built)
    expect(built.events).toEqual([])
    expect(Object.keys(built.liveAgentByPaneKey)).toEqual([])
    const classified = classifyChildAgents(threads)
    expect(classified.parentPaneKeyByChild.get(PANE_KEY_2)).toBe(parent)
    expect(classified.hidden.has(PANE_KEY_2)).toBe(parent !== undefined)
  }
})

it('refreshes selected sleeping ownership with a stable resolver and host-qualified catalog', () => {
  const cache = createActivityEventBuildCache()
  const source: AgentStatusEntry = {
    paneKey: PANE_KEY,
    state: 'done',
    sessionBoundary: true,
    agentType: 'claude',
    stateStartedAt: 100,
    updatedAt: 100,
    prompt: 'slept',
    stateHistory: [],
    connectionId: 'a'
  }
  const localRepo = { ...makeRepo(), displayName: 'local twin', executionHostId: 'local' as const }
  const remoteRepo = {
    ...makeRepo(),
    displayName: 'remote owner',
    executionHostId: 'ssh:a' as const
  }
  let known: Worktree | undefined
  const resolveWorktree = () => known
  let args = {
    chatNames: new Map(),
    agentStatusByPaneKey: {},
    sleepingAgentStatusByPaneKey: new Map([[PANE_KEY, source]]),
    tabsByWorktree: { 'wt-1': [makeTab()] },
    worktreeMap: new Map<string, Worktree>(),
    repoMap: new Map([[localRepo.id, localRepo]]),
    repos: [localRepo, remoteRepo],
    resolveWorktree,
    ownerCatalog: [{}],
    acknowledgedAgentsByPaneKey: {},
    now: 1000
  }
  const probe = vi.spyOn(paneBuilds, 'resolvePaneBuild')
  try {
    const missing = buildActivityEvents(args, cache)
    expect(missing.passiveAgentByPaneKey[PANE_KEY].worktree.path).toBe('')
    known = { ...makeWorktree(), hostId: 'ssh:a', displayName: 'discovered owner' }
    args = { ...args, ownerCatalog: [{}] }
    const resolved = buildActivityEvents(args, cache)
    expect(resolved.passiveAgentByPaneKey[PANE_KEY].worktree).toBe(known)
    expect(resolved.passiveAgentByPaneKey[PANE_KEY].repo).toBe(remoteRepo)
    probe.mockClear()
    args = { ...args, repos: [{ ...localRepo, displayName: 'unrelated change' }, remoteRepo] }
    buildActivityEvents(args, cache)
    expect(probe).not.toHaveBeenCalled()
    const renamed = { ...remoteRepo, displayName: 'renamed remote owner' }
    args = { ...args, repos: [localRepo, renamed] }
    expect(buildActivityEvents(args, cache).passiveAgentByPaneKey[PANE_KEY].repo).toBe(renamed)
    expect(probe).toHaveBeenCalledTimes(1)
    known = undefined
    const missingAgain = buildActivityEvents({ ...args, ownerCatalog: [{}] }, cache)
    expect(missingAgain.passiveAgentByPaneKey[PANE_KEY].worktree.path).toBe('')
    known = { ...makeWorktree(), hostId: 'ssh:a' }
    expect(
      buildActivityEvents({ ...args, ownerCatalog: undefined }, cache).passiveAgentByPaneKey[
        PANE_KEY
      ].worktree
    ).toBe(known)
  } finally {
    probe.mockRestore()
  }
})
