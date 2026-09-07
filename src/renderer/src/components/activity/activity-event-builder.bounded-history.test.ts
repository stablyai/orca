import { describe, expect, it } from 'vitest'
import type {
  AgentStateHistoryEntry,
  AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { buildActivityEvents, newestActivityHistoryEntries } from './activity-event-builder'
import { EVENTS_PER_PANE_CAP } from './activity-event-cap'
import { makeRepo, makeTab, makeWorktree, PANE_KEY } from './ActivityPrototypePage-test-fixtures'

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
    expect(events).toHaveLength(0)
  })
})
