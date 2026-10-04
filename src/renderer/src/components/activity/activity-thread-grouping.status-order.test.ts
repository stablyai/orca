import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentTurnOutcome } from '../../../../shared/agent-turn-outcome'
import { buildActivityThreadGroups, getActivityThreadGroup } from './activity-thread-grouping'
import { activityThreadStatusId } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'
import {
  makeRepo,
  makeTabWithIds,
  makeThreads,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2,
  PANE_KEY_3
} from './ActivityPrototypePage-test-fixtures'
import { buildActivityEvents } from './activity-event-builder'

type StatusFixture = {
  paneKey: string
  state: AgentStatusEntry['state']
  at: number
  /** The main agent's verdict on its finished turn. */
  outcome?: AgentTurnOutcome
}

function makeStatusThreads(fixtures: StatusFixture[]): AgentPaneThread[] {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const tabs = fixtures.map((_fixture, index) => makeTabWithIds(`tab-${index + 1}`, worktree.id))
  const agentStatusByPaneKey = Object.fromEntries(
    fixtures.map((fixture) => [
      fixture.paneKey,
      {
        state: fixture.state,
        prompt: 'Prompt',
        updatedAt: fixture.at,
        stateStartedAt: fixture.at,
        paneKey: fixture.paneKey,
        terminalTitle: 'Claude',
        stateHistory: [],
        agentType: 'claude',
        ...(fixture.outcome
          ? {
              mainAgent: {
                state: fixture.state,
                outcome: fixture.outcome,
                stateStartedAt: fixture.at
              }
            }
          : {})
      } satisfies AgentStatusEntry
    ])
  )
  return makeThreads(
    buildActivityEvents({
      agentStatusByPaneKey,
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [worktree.id]: tabs },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: Math.max(...fixtures.map((fixture) => fixture.at))
    })
  )
}

describe('status group order', () => {
  it('ranks Working above Done even when the Done thread is newer', () => {
    const threads = makeStatusThreads([
      { paneKey: PANE_KEY, state: 'working', at: 1_000 },
      { paneKey: PANE_KEY_2, state: 'done', at: 5_000 }
    ])
    expect(threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_2, PANE_KEY])

    const groups = buildActivityThreadGroups(threads, 'status')

    expect(groups.map((group) => group.key)).toEqual(['working', 'done'])
  })

  it("ranks a user's Stop and a replaced turn below live work, above Done", () => {
    for (const outcome of ['cancellation', 'superseded'] as const) {
      const groups = buildActivityThreadGroups(
        makeStatusThreads([
          { paneKey: PANE_KEY, state: 'working', at: 1_000 },
          { paneKey: PANE_KEY_2, state: 'done', at: 3_000 },
          { paneKey: PANE_KEY_3, state: 'done', at: 5_000, outcome }
        ]),
        'status'
      )

      expect(
        groups.map((group) => group.key),
        outcome
      ).toEqual(['working', 'interrupted', 'done'])
    }
  })

  it('keeps a failure and an unproven end above live work', () => {
    const groups = buildActivityThreadGroups(
      makeStatusThreads([
        { paneKey: PANE_KEY, state: 'working', at: 5_000 },
        { paneKey: PANE_KEY_2, state: 'done', at: 1_000, outcome: 'unconfirmed' },
        { paneKey: PANE_KEY_3, state: 'done', at: 3_000, outcome: 'interruption' }
      ]),
      'status'
    )

    expect(groups.map((group) => group.key)).toEqual(['failed', 'unconfirmed', 'working'])
  })

  it('keeps attention headers in a fixed order regardless of thread recency', () => {
    const newerBlocked = buildActivityThreadGroups(
      makeStatusThreads([
        { paneKey: PANE_KEY, state: 'waiting', at: 1_000 },
        { paneKey: PANE_KEY_2, state: 'blocked', at: 5_000 }
      ]),
      'status'
    )
    const newerWaiting = buildActivityThreadGroups(
      makeStatusThreads([
        { paneKey: PANE_KEY, state: 'waiting', at: 5_000 },
        { paneKey: PANE_KEY_2, state: 'blocked', at: 1_000 }
      ]),
      'status'
    )

    expect(newerBlocked.map((group) => group.key)).toEqual(['waiting', 'blocked'])
    expect(newerWaiting.map((group) => group.key)).toEqual(['waiting', 'blocked'])
  })

  it('keeps newest-first thread order inside each group', () => {
    const groups = buildActivityThreadGroups(
      makeStatusThreads([
        { paneKey: PANE_KEY, state: 'done', at: 1_000 },
        { paneKey: PANE_KEY_2, state: 'working', at: 2_000 },
        { paneKey: PANE_KEY_3, state: 'done', at: 3_000 }
      ]),
      'status'
    )

    expect(groups.map((group) => group.key)).toEqual(['working', 'done'])
    expect(groups[1].threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_3, PANE_KEY])
  })

  it('gives every status group a header state equal to its rows', () => {
    const groups = buildActivityThreadGroups(
      makeStatusThreads([
        { paneKey: PANE_KEY, state: 'blocked', at: 1_000 },
        { paneKey: PANE_KEY_2, state: 'working', at: 2_000 },
        { paneKey: PANE_KEY_3, state: 'done', at: 3_000 }
      ]),
      'status'
    )

    expect(groups.map((group) => group.state)).toEqual(['blocked', 'working', 'done'])
    for (const group of groups) {
      for (const thread of group.threads) {
        expect(activityThreadStatusId(thread)).toBe(group.state)
      }
    }
  })

  it('does not rank or set a header state outside status mode', () => {
    const threads = makeStatusThreads([
      { paneKey: PANE_KEY, state: 'working', at: 1_000 },
      { paneKey: PANE_KEY_2, state: 'done', at: 5_000 }
    ])

    for (const groupBy of ['project', 'worktree', 'agent'] as const) {
      const groups = buildActivityThreadGroups(threads, groupBy)
      expect(groups[0].state).toBeUndefined()
      expect(groups[0].threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_2, PANE_KEY])
      expect(getActivityThreadGroup(threads[0], groupBy).state).toBeUndefined()
    }
  })
})
