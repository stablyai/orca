import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { patchDashboardSnapshotFromAgentStatus } from './dashboard-agent-status-patch'

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
    toolName: 'AskUserQuestion',
    ...overrides
  }
}

function snapshot(cards: DashboardCard[] = [card()]): DashboardSnapshot {
  return { generatedAt: 200, cards }
}

describe('patchDashboardSnapshotFromAgentStatus', () => {
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
      interactiveToolName: 'AskUserQuestion',
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
        interactiveToolName: 'AskUserQuestion',
        lastAgentMessage: 'Waiting',
        stateChangedAt: 250,
        unseen: true
      })
    ])
    const result = patchDashboardSnapshotFromAgentStatus(
      original,
      event({
        state: 'waiting',
        prompt: '',
        interactivePrompt: undefined,
        toolName: undefined,
        stateStartedAt: 250
      })
    )

    expect(result.snapshot.cards[0]).toMatchObject({
      task: 'old task',
      askSummary: 'Pick one',
      interactiveToolName: 'AskUserQuestion',
      lastAgentMessage: 'Waiting',
      unseen: true
    })
  })

  it('clears interactive question fields when the agent leaves attention', () => {
    const original = snapshot([
      card({
        bucket: 'attention',
        dotState: 'waiting',
        askSummary: 'Pick one',
        interactiveToolName: 'AskUserQuestion'
      })
    ])

    const result = patchDashboardSnapshotFromAgentStatus(
      original,
      event({ state: 'working', interactivePrompt: '', toolName: '', stateStartedAt: 300 })
    )

    expect(result.snapshot.cards[0].askSummary).toBeUndefined()
    expect(result.snapshot.cards[0].interactiveToolName).toBeUndefined()
  })

  it('opens a chat card when its live status reports the provider session', () => {
    const original = snapshot([
      card({ viewMode: 'chat', sessionId: undefined, transcriptPath: undefined })
    ])

    const result = patchDashboardSnapshotFromAgentStatus(
      original,
      event({
        providerSession: {
          key: 'session_id',
          id: 'session-2',
          transcriptPath: '/tmp/session-2.jsonl'
        }
      })
    )

    expect(result.snapshot.cards[0]).toMatchObject({
      sessionId: 'session-2',
      transcriptPath: '/tmp/session-2.jsonl'
    })
  })

  it('clears a stale transcript path when the provider session changes without one', () => {
    const original = snapshot([
      card({
        viewMode: 'chat',
        sessionId: 'session-1',
        transcriptPath: '/tmp/session-1.jsonl'
      })
    ])

    const result = patchDashboardSnapshotFromAgentStatus(
      original,
      event({ providerSession: { key: 'session_id', id: 'session-2' } })
    )

    expect(result.snapshot.cards[0]?.sessionId).toBe('session-2')
    expect(result.snapshot.cards[0]?.transcriptPath).toBeUndefined()
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
