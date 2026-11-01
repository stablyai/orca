import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { patchDashboardSnapshotFromAgentStatus } from './dashboard-agent-status-patch'
import { dashboardCardDisplayState } from '../../../../shared/dashboard-snapshot'

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab-1:leaf-1',
    ptyId: 'pty-1',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'old task',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Repo',
    worktreeName: 'Worktree',
    startedAt: 100,
    finishedAt: null,
    stateChangedAt: 100,
    statusUpdatedAt: 150,
    unseen: false,
    ...overrides
  }
}

function event(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'blocked',
    prompt: 'Need a decision',
    connectionId: null,
    receivedAt: 300,
    stateStartedAt: 250,
    interactivePrompt: '{"question":"Continue?"}',
    ...overrides
  }
}

function snapshot(cards: DashboardCard[] = [card()]): DashboardSnapshot {
  return { generatedAt: 200, cards }
}

describe('patchDashboardSnapshotFromAgentStatus', () => {
  it('ignores stale, wrong-workspace, and session-only events', () => {
    const original = snapshot()
    expect(
      patchDashboardSnapshotFromAgentStatus(original, event({ receivedAt: 150 })).snapshot
    ).toBe(original)
    expect(
      patchDashboardSnapshotFromAgentStatus(original, event({ worktreeId: 'other' })).snapshot
    ).toBe(original)
    expect(
      patchDashboardSnapshotFromAgentStatus(original, event({ providerSessionOnly: true })).snapshot
    ).toBe(original)
  })

  it('moves an unread plain-Stop completion into Needs You', () => {
    const patched = patchDashboardSnapshotFromAgentStatus(
      snapshot(),
      event({
        state: 'done',
        prompt: 'Should I tag v2.1 now?',
        interactivePrompt: undefined,
        lastAssistantMessage: 'Should I tag v2.1 now?'
      })
    ).snapshot
    // A plain-text question ends the turn without a hook prompt; until the user
    // opens the agent (the next full snapshot carries the ack) it waits in Needs You.
    expect(patched.cards[0]).toMatchObject({
      bucket: 'attention',
      dotState: 'done',
      unseen: true,
      finishedAt: 250,
      askSummary: undefined
    })
    expect(dashboardCardDisplayState(patched.cards[0])).toBe('done')
  })
})
