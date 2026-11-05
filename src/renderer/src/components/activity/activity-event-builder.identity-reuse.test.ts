import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStateHistoryEntry } from '../../../../shared/agent-status/lifecycle/agent-state-history'

import { buildActivityEvents } from './activity-event-builder'

import { makeRepo, makeTab, makeWorktree, PANE_KEY } from './ActivityPrototypePage-test-fixtures'

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
      chatNames: new Map(),
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
  })
}
