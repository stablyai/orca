import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import {
  buildActivityThreadGroups,
  buildActivityEvents,
  buildAgentPaneThreads,
  getActivityThreadGroup
} from './ActivityPrototypePage'
import {
  makeActivityResult,
  makeRepo,
  makeTabWithIds,
  makeThreads,
  makeWorkingEntryWithoutHistory,
  makeWorktree,
  makeWorktreeWithId,
  PANE_KEY,
  PANE_KEY_2,
  PANE_KEY_A1,
  PANE_KEY_A2,
  PANE_KEY_B1,
  UNKNOWN_PANE_KEY
} from './ActivityPrototypePage-test-fixtures'

describe('activity thread grouping', () => {
  it('status grouping separates interrupted done from normal done and keeps Interrupted label', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab1 = makeTabWithIds('tab-1', worktree.id)
    const tab2 = makeTabWithIds('tab-2', worktree.id)
    const sharedDone: Omit<
      AgentStatusEntry,
      'paneKey' | 'interrupted' | 'updatedAt' | 'stateStartedAt'
    > = {
      state: 'done',
      prompt: 'Prompt',
      terminalTitle: 'Claude',
      stateHistory: [],
      agentType: 'claude'
    }
    const { events, liveAgentByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          ...sharedDone,
          paneKey: PANE_KEY,
          interrupted: true,
          updatedAt: 3_000,
          stateStartedAt: 3_000
        },
        [PANE_KEY_2]: {
          ...sharedDone,
          paneKey: PANE_KEY_2,
          interrupted: false,
          updatedAt: 2_000,
          stateStartedAt: 2_000
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [worktree.id]: [tab1, tab2] },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })
    const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey })
    const groups = buildActivityThreadGroups(threads, 'status')

    expect(groups).toHaveLength(2)
    expect(groups[0].key).toBe('done:interrupted')
    expect(groups[0].label).toBe('Interrupted')
    expect(groups[1].key).toBe('done')
    expect(groups[1].label).toBe('Done')
  })

  it('project grouping falls back to unknown project when repo is missing', () => {
    const worktree = makeWorktreeWithId('wt-unknown', 'missing-repo', 'unknown-wt')
    const tab = makeTabWithIds('tab-unknown', worktree.id)
    const { events, liveAgentByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: {
        [UNKNOWN_PANE_KEY]: {
          state: 'done',
          prompt: 'Prompt',
          updatedAt: 1_000,
          stateStartedAt: 1_000,
          paneKey: UNKNOWN_PANE_KEY,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [worktree.id]: [tab] },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map(),
      acknowledgedAgentsByPaneKey: {},
      now: 1_000
    })
    const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey })
    const group = getActivityThreadGroup(threads[0], 'project')

    expect(group).toEqual({ key: 'project:unknown', label: 'Unknown project' })
  })

  it('worktree and agent grouping use expected keys and labels', () => {
    const result = makeActivityResult({
      entries: {
        [PANE_KEY]: makeWorkingEntryWithoutHistory()
      }
    })
    const threads = makeThreads(result)

    expect(getActivityThreadGroup(threads[0], 'worktree')).toEqual({
      key: 'worktree:wt-1',
      label: 'feature'
    })
    expect(getActivityThreadGroup(threads[0], 'agent')).toEqual({
      key: 'agent:claude',
      label: formatAgentTypeLabel('claude')
    })
  })

  it('keeps first-appearance group order and preserves intra-group thread order', () => {
    const repo = makeRepo()
    const wtA = makeWorktreeWithId('wt-a', repo.id, 'alpha')
    const wtB = makeWorktreeWithId('wt-b', repo.id, 'beta')
    const tabA1 = makeTabWithIds('tab-a1', wtA.id)
    const tabB1 = makeTabWithIds('tab-b1', wtB.id)
    const tabA2 = makeTabWithIds('tab-a2', wtA.id)
    const { events, liveAgentByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: {
        [PANE_KEY_A1]: {
          state: 'done',
          prompt: 'A1',
          updatedAt: 3_000,
          stateStartedAt: 3_000,
          paneKey: PANE_KEY_A1,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        },
        [PANE_KEY_B1]: {
          state: 'done',
          prompt: 'B1',
          updatedAt: 2_000,
          stateStartedAt: 2_000,
          paneKey: PANE_KEY_B1,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        },
        [PANE_KEY_A2]: {
          state: 'done',
          prompt: 'A2',
          updatedAt: 1_000,
          stateStartedAt: 1_000,
          paneKey: PANE_KEY_A2,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude'
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [wtA.id]: [tabA1, tabA2], [wtB.id]: [tabB1] },
      worktreeMap: new Map([
        [wtA.id, wtA],
        [wtB.id, wtB]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })
    const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey })
    const groups = buildActivityThreadGroups(threads, 'worktree')

    expect(groups.map((group) => group.key)).toEqual(['worktree:wt-a', 'worktree:wt-b'])
    expect(groups[0].threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_A1, PANE_KEY_A2])
    expect(groups[1].threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_B1])
  })

  it('returns no groups for empty thread input', () => {
    expect(buildActivityThreadGroups([], 'status')).toEqual([])
  })
})
