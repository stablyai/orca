import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildActivityEvents } from './activity-event-builder'
import { buildAgentPaneThreads } from './activity-thread-builder'
import {
  LEAF_ID,
  makeRepo,
  makeTabWithIds,
  makeWorktree
} from './ActivityPrototypePage-test-fixtures'

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

  it('keeps progress rows visible but quiet in result-focused mode', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTabWithIds('tab-progress', worktree.id)
    const paneKey = makePaneKey(tab.id, LEAF_ID)
    const entry: AgentStatusEntry = {
      paneKey,
      state: 'working',
      prompt: 'Run checks',
      stateStartedAt: 2_000,
      updatedAt: 3_000,
      stateHistory: [
        {
          state: 'done',
          prompt: 'Previous result',
          startedAt: 1_000,
          notificationIntent: 'result'
        }
      ],
      agentType: 'codex',
      toolName: 'Bash',
      toolInput: 'pnpm test'
    }
    const build = (manuallyUnreadTurnsByPaneKey?: Record<string, number>) =>
      buildActivityEvents({
        agentStatusByPaneKey: { [paneKey]: entry },
        retainedAgentsByPaneKey: {},
        tabsByWorktree: { [worktree.id]: [tab] },
        worktreeMap: new Map([[worktree.id, worktree]]),
        repoMap: new Map([[repo.id, repo]]),
        acknowledgedAgentsByPaneKey: {},
        manuallyUnreadTurnsByPaneKey,
        agentNotificationMode: 'results-and-actions',
        now: 3_000
      }).events

    expect(build()).toEqual([
      expect.objectContaining({ timestamp: 2_000, state: 'working', unread: false }),
      expect.objectContaining({ timestamp: 1_000, state: 'done', unread: true })
    ])
    expect(build({ [paneKey]: 2_000 })[0]).toMatchObject({
      timestamp: 2_000,
      state: 'working',
      unread: true
    })
  })
})
