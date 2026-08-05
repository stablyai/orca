import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import { selectWorktreeActivityStatuses } from './use-worktree-activity-statuses'

type StatusState = Parameters<typeof selectWorktreeActivityStatuses>[0]

function makeStatusState(): StatusState {
  return {
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    agentStatusEpoch: 0,
    agentStatusByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {}
  }
}

describe('selectWorktreeActivityStatuses', () => {
  it('stays shallow-equal when an unrelated worktree receives activity updates', () => {
    const state = makeStatusState()
    const unrelatedUpdate: StatusState = {
      ...state,
      agentStatusEpoch: 1,
      browserTabsByWorktree: {
        other: []
      },
      runtimePaneTitlesByTabId: {
        'other-tab': { 0: 'codex [working]' }
      },
      ptyIdsByTabId: {
        'other-tab': ['other-pty']
      }
    }

    expect(
      shallow(
        selectWorktreeActivityStatuses(state, ['visible']),
        selectWorktreeActivityStatuses(unrelatedUpdate, ['visible'])
      )
    ).toBe(true)
  })
})
