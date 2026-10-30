import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
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
  it.each(['cancellation', 'failure', 'unconfirmed'] as const)(
    'projects a newer %s verdict and clears it on the next full status',
    (outcome) => {
      const patched = patchDashboardSnapshotFromAgentStatus(
        snapshot(),
        event({
          state: 'done',
          mainAgent: { state: 'done', outcome, stateStartedAt: 250 }
        })
      ).snapshot
      expect(dashboardCardDisplayState(patched.cards[0])).toBe(
        outcome === 'cancellation'
          ? 'interrupted'
          : outcome === 'failure'
            ? 'failed'
            : 'unconfirmed'
      )
      expect(patched.cards[0].bucket).toBe('done')
      for (const interrupted of [undefined, false]) {
        const cleared = patchDashboardSnapshotFromAgentStatus(
          patched,
          event({ state: 'working', interrupted, receivedAt: 400, stateStartedAt: 350 })
        ).snapshot
        expect(dashboardCardDisplayState(cleared.cards[0])).toBe('working')
      }
      expect(
        patchDashboardSnapshotFromAgentStatus(
          patched,
          event({ receivedAt: 400, programStatusOnly: true })
        ).snapshot
      ).toBe(patched)
      expect(
        patchDashboardSnapshotFromAgentStatus(
          patched,
          event({ receivedAt: 400, providerSessionOnly: true })
        ).snapshot
      ).toBe(patched)
    }
  )

  it('patches one known card without rebuilding the dashboard topology', () => {
    const original = snapshot([card(), card({ paneKey: 'tab-2:leaf-2' })])
    const result = patchDashboardSnapshotFromAgentStatus(original, event())

    expect(result.matched).toBe(true)
    expect(result.snapshot.cards[0]).toMatchObject({
      bucket: 'attention',
      dotState: 'blocked',
      task: 'Need a decision',
      lastUserMessage: 'Need a decision',
      askSummary: '{"question":"Continue?"}',
      stateChangedAt: 250,
      statusUpdatedAt: 300,
      unseen: true
    })
    expect(result.snapshot.cards[1]).toBe(original.cards[1])
  })

  it('preserves cached fields omitted from same-state hook pings', () => {
    const original = snapshot([
      card({
        bucket: 'attention',
        dotState: 'waiting',
        askSummary: 'Pick one',
        lastAgentMessage: 'Waiting',
        stateChangedAt: 250,
        unseen: true
      })
    ])
    const result = patchDashboardSnapshotFromAgentStatus(
      original,
      event({ state: 'waiting', prompt: '', interactivePrompt: undefined, stateStartedAt: 250 })
    )

    expect(result.snapshot.cards[0]).toMatchObject({
      task: 'old task',
      askSummary: 'Pick one',
      lastAgentMessage: 'Waiting',
      unseen: true
    })
  })

  it('patches same-state working into passive monitoring', () => {
    const result = patchDashboardSnapshotFromAgentStatus(
      snapshot(),
      event({ state: 'working', workingMode: 'monitoring', stateStartedAt: 100 })
    )

    expect(result.snapshot.cards[0]).toMatchObject({
      bucket: 'working',
      dotState: 'working',
      workingMode: 'monitoring'
    })
  })

  it('keeps an unverifiable child compatible with the pop-out wire vocabulary', () => {
    const result = patchDashboardSnapshotFromAgentStatus(
      snapshot(),
      event({
        subagents: [{ id: 'child-1', state: 'unverifiable', startedAt: 100 }]
      })
    )

    expect(result.snapshot.cards[0].subagents).toEqual([
      {
        id: 'tab-1:leaf-1\u0000subagent:child-1',
        name: 'unknown',
        dotState: 'idle'
      }
    ])
  })

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

  it('asks the caller for topology only when the pane is unknown', () => {
    const original = snapshot()
    const result = patchDashboardSnapshotFromAgentStatus(
      original,
      event({ paneKey: 'tab-new:leaf-new' })
    )

    expect(result).toEqual({ matched: false, snapshot: original })
  })
})
