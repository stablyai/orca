import { expect, it } from 'vitest'
import type { AppState } from '../../store/types'
import {
  makeRepo,
  makeTab,
  makeWorktree,
  PANE_KEY
} from '../../components/activity/ActivityPrototypePage-test-fixtures'
import { buildAgentActivitySubjects } from './agent-activity-subjects'

it('publishes desktop event clocks, excludes heartbeat timestamps, and respects clearing', () => {
  const repo = makeRepo()
  const worktree = makeWorktree()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every field read by the activity publisher; unrelated AppState actions are unused.
  const state = {
    settings: { activeRuntimeEnvironmentId: 'unrelated-focused-host' },
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    tabsByWorktree: { [worktree.id]: [makeTab()] },
    unifiedTabsByWorktree: {},
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        state: 'done',
        prompt: 'Complete review',
        agentType: 'codex',
        stateStartedAt: 2000,
        updatedAt: 9000,
        stateHistory: [{ state: 'working', prompt: 'Complete review', startedAt: 1000 }]
      }
    }
  } as unknown as AppState
  expect(buildAgentActivitySubjects(state)).toEqual([
    {
      paneKey: PANE_KEY,
      worktreeId: worktree.id,
      hostId: 'local',
      latestActivityAt: 2000,
      stateStartedAt: 2000
    }
  ])
  expect(
    buildAgentActivitySubjects({ ...state, activityClearedAtByPaneKey: { [PANE_KEY]: 2000 } })
  ).toEqual([])
})
