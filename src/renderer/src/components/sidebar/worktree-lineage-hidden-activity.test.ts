import { describe, expect, it } from 'vitest'
import {
  getLineageHiddenActivityLabel,
  getLineageHiddenActivityStatus,
  selectLineageHiddenActivity,
  summarizeLineageHiddenActivity
} from './worktree-lineage-hidden-activity'

type StatusState = Parameters<typeof selectLineageHiddenActivity>[0]

function makeStatusState(titlesByWorktreeId: Record<string, string>): StatusState {
  const tabsByWorktree: StatusState['tabsByWorktree'] = {}
  const ptyIdsByTabId: StatusState['ptyIdsByTabId'] = {}
  for (const [worktreeId, title] of Object.entries(titlesByWorktreeId)) {
    const tabId = `${worktreeId}-tab`
    tabsByWorktree[worktreeId] = [
      {
        id: tabId,
        ptyId: `${worktreeId}-pty`,
        worktreeId,
        title,
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
    ptyIdsByTabId[tabId] = [`${worktreeId}-pty`]
  }
  return {
    tabsByWorktree,
    browserTabsByWorktree: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId,
    terminalLayoutsByTabId: {},
    agentStatusEpoch: 0,
    agentStatusByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {}
  }
}

describe('lineage hidden activity', () => {
  it('counts attention states and ranks them the way the card resolves its own status', () => {
    const activity = summarizeLineageHiddenActivity([
      'working',
      'done',
      'monitoring',
      'working',
      'failed',
      'interrupted',
      'inactive',
      'permission'
    ])

    expect(activity).toEqual({
      permission: 1,
      failed: 1,
      working: 2,
      monitoring: 1,
      interrupted: 1
    })
    expect(getLineageHiddenActivityStatus(activity)).toBe('permission')
    expect(getLineageHiddenActivityLabel(activity, 0)).toBe(
      '1 waiting for permission · 1 failed · 2 working · 1 monitoring background tasks · 1 interrupted'
    )
  })

  it('surfaces a hidden failure over live work, and a stop only once nothing is live', () => {
    expect(
      getLineageHiddenActivityStatus(summarizeLineageHiddenActivity(['working', 'failed']))
    ).toBe('failed')
    expect(
      getLineageHiddenActivityStatus(summarizeLineageHiddenActivity(['interrupted', 'monitoring']))
    ).toBe('monitoring')
    expect(
      getLineageHiddenActivityStatus(summarizeLineageHiddenActivity(['interrupted', 'done']))
    ).toBe('interrupted')
  })

  it('stays quiet when every hidden worktree is finished, read or idle', () => {
    const activity = summarizeLineageHiddenActivity(['done', 'active', 'inactive'])

    expect(getLineageHiddenActivityStatus(activity)).toBeNull()
    expect(getLineageHiddenActivityLabel(activity, 0)).toBeNull()
  })

  it('names unread hidden worktrees after live work', () => {
    const finished = summarizeLineageHiddenActivity(['done'])
    const mixed = summarizeLineageHiddenActivity(['working', 'done'])

    expect(getLineageHiddenActivityLabel(finished, 1)).toBe('1 unread')
    expect(getLineageHiddenActivityLabel(mixed, 2)).toBe('1 working · 2 unread')
  })

  it('reads each hidden worktree through the same status the card would show', () => {
    const state = makeStatusState({
      child: 'claude [done]',
      grandchild: 'claude [working]',
      unrelated: 'claude [permission]'
    })

    expect(selectLineageHiddenActivity(state, ['child', 'grandchild'])).toEqual({
      permission: 0,
      failed: 0,
      working: 1,
      monitoring: 0,
      interrupted: 0
    })
  })
})
