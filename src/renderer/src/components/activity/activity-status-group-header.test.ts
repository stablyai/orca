import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  buildActivityEvents,
  buildActivityThreadGroups,
  buildAgentPaneThreads
} from './ActivityPrototypePage'
import {
  makeRepo,
  makeTabWithIds,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2
} from './ActivityPrototypePage-test-fixtures'
import { activityThreadStatusId } from './activity-thread-presentation'

type Ending = 'cancellation' | 'interruption' | 'failure'

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

/** The threads for two ended panes, `newer` the most recent. */
function endedThreads(
  newer: Ending,
  older: Ending,
  acknowledgedAgentsByPaneKey: Record<string, number> = {}
) {
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
    acknowledgedAgentsByPaneKey,
    now: 3_000
  })
  return buildAgentPaneThreads({ events, liveAgentByPaneKey, acknowledgedAgentsByPaneKey })
}

/** Status groups for two ended panes, `newer` the most recent. */
function statusGroups(newer: Ending, older: Ending) {
  return buildActivityThreadGroups(endedThreads(newer, older), 'status')
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

describe('a thread cut short with nobody asking', () => {
  // The same acknowledgement as the sidebar: news until seen, then it reads like a finished turn.
  it('leaves Failed, and its "Failed" line, once the user has seen it; a failure stays', () => {
    const unseen = endedThreads('interruption', 'failure')
    const seen = endedThreads('interruption', 'failure', { [PANE_KEY]: 3_000, [PANE_KEY_2]: 2_000 })
    const cut = (threads: typeof seen) => threads.find((thread) => thread.paneKey === PANE_KEY)
    const failed = (threads: typeof seen) => threads.find((thread) => thread.paneKey === PANE_KEY_2)

    expect(activityThreadStatusId(cut(unseen)!)).toBe('failed')
    expect(cut(unseen)?.responsePreview).toBe('Failed')
    expect(activityThreadStatusId(cut(seen)!)).toBe('done')
    expect(cut(seen)?.responsePreview).not.toBe('Failed')
    expect(activityThreadStatusId(failed(seen)!)).toBe('failed')
    expect(failed(seen)?.responsePreview).toBe('Failed')
  })
})
