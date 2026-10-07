import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { buildActivityEvents } from './activity-event-builder'
import { buildActivityThreadGroups } from './activity-thread-grouping'
import { buildAgentPaneThreads } from './activity-thread-builder'
import {
  makeRepo,
  makeTabWithIds,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2
} from './ActivityPrototypePage-test-fixtures'

type Ending = 'cancellation' | 'interruption'

function doneEntry(paneKey: string, outcome: Ending, at: number): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Prompt',
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    paneKey,
    interrupted: outcome === 'cancellation',
    updatedAt: at,
    stateStartedAt: at,
    mainAgent: { state: 'done', outcome, stateStartedAt: at }
  }
}

/** Status groups for two ended panes, `newer` the most recent. */
function statusGroups(newer: Ending, older: Ending) {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const { events, liveAgentByPaneKey } = buildActivityEvents({
    agentStatusByPaneKey: {
      [PANE_KEY]: doneEntry(PANE_KEY, newer, 3_000),
      [PANE_KEY_2]: doneEntry(PANE_KEY_2, older, 2_000)
    },
    retainedAgentsByPaneKey: {},
    tabsByWorktree: {
      [worktree.id]: [makeTabWithIds('tab-1', worktree.id), makeTabWithIds('tab-2', worktree.id)]
    },
    worktreeMap: new Map([[worktree.id, worktree]]),
    repoMap: new Map([[repo.id, repo]]),
    acknowledgedAgentsByPaneKey: {},
    now: 3_000
  })
  return buildActivityThreadGroups(buildAgentPaneThreads({ events, liveAgentByPaneKey }), 'status')
}

describe('the status group headers', () => {
  it.each([
    { newer: 'cancellation', older: 'interruption' },
    { newer: 'interruption', older: 'cancellation' }
  ] as const)(
    "never mixes a user's Stop with a crash, whichever is newest ($newer newest)",
    ({ newer, older }) => {
      const groups = statusGroups(newer, older)

      // A crash sits with failures; the Stop alone heads Interrupted, below it.
      expect(groups.map((group) => [group.key, group.state, group.label])).toEqual([
        ['failed', 'failed', 'Failed'],
        ['interrupted', 'interrupted', 'Interrupted']
      ])
    }
  )

  it("heads a group of user's Stops with the interrupted glyph", () => {
    const groups = statusGroups('cancellation', 'cancellation')

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'interrupted', state: 'interrupted' })
  })
})
