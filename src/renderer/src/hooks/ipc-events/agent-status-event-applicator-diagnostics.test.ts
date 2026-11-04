import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { PendingAgentStatusEvent } from './agent-status-bridge-types'
import { buildStoreState, FUTURE_PANE_KEY } from '../ipc-events-agent-status-store-test-fixtures'

beforeEach(() => vi.resetModules())
afterEach(() => vi.restoreAllMocks())

async function setup() {
  const setAgentStatus = vi.fn()
  const track = vi.fn()
  const state = buildStoreState({
    setAgentStatus,
    workspaceSessionReady: true,
    tabsByWorktree: {}
  })
  vi.doMock('../../store/index', () => ({ useAppStore: { getState: () => state } }))
  vi.doMock('@/lib/telemetry', () => ({ track }))
  vi.doMock('../agent-hook-completion-notifications', () => ({
    observeAgentHookCompletionForNotification: vi.fn()
  }))
  const pending: PendingAgentStatusEvent[] = []
  const enqueue = vi.fn((data: AgentStatusIpcPayload) => {
    pending.push({ data, firstSeenAt: Date.now(), replay: false })
  })
  const { createAgentStatusEventApplicator } = await import('./agent-status-event-applicator')
  const apply = createAgentStatusEventApplicator({
    pendingAgentStatusEvents: pending,
    transientClearWatermarkByConnectionId: new Map(),
    enqueuePendingAgentStatus: enqueue
  })
  return { apply, state, pending, enqueue, track, setAgentStatus }
}

const event: AgentStatusIpcPayload = {
  paneKey: FUTURE_PANE_KEY,
  connectionId: null,
  state: 'working',
  agentType: 'codex',
  prompt: 'task',
  receivedAt: 1_000,
  stateStartedAt: 1_000
}

describe('unresolved status diagnostic admission', () => {
  it('queues every live observation, applies a recovered owner, and reports a new failure', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { apply, state, pending, enqueue, track, setAgentStatus } = await setup()
    for (let index = 0; index < 1_000; index++) {
      expect(apply({ ...event, receivedAt: 1_000 + index })).toBe('pending')
    }
    expect(track).toHaveBeenCalledExactlyOnceWith('agent_hook_unattributed', {
      reason: 'unknown_tab_id'
    })
    expect(enqueue).toHaveBeenCalledTimes(1_000)
    expect(apply(event, { retry: true })).toBe('pending')
    expect(apply(event, { replay: true })).toBe('dropped')
    expect(track).toHaveBeenCalledTimes(1)
    state.tabsByWorktree = {
      'wt-1': [{ id: 'tab-future', worktreeId: 'wt-1', title: 'Codex' }]
    }
    expect(apply(event, { retry: true })).toBe('applied')
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working' }),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ worktreeId: 'wt-1' }),
      undefined
    )
    expect(pending).toHaveLength(1_000)
    state.tabsByWorktree = {}
    expect(apply(event)).toBe('pending')
    expect(track).toHaveBeenCalledTimes(2)
  })

  it.each([null, 'remote-1'])(
    'preserves diagnostic cooldown across worktree fallback on host %s',
    async (host) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const { apply, state, track } = await setup()
      state.repos = [{ id: 'repo-1', connectionId: host }]
      state.worktreesByRepo = { 'repo-1': [{ id: 'folder-1', repoId: 'repo-1' }] }
      const unresolved = { ...event, connectionId: host, worktreeId: 'folder-1' }
      const runtimeBacked = { ...unresolved, terminalHandle: 'terminal' }

      for (let index = 0; index < 3; index++) {
        expect(apply(unresolved)).toBe('pending')
        expect(apply(runtimeBacked)).toBe('applied')
      }
      expect(track).toHaveBeenCalledExactlyOnceWith('agent_hook_unattributed', {
        reason: 'unknown_tab_id'
      })

      now.mockReturnValue(301_000)
      expect(apply(unresolved)).toBe('pending')
      expect(track).toHaveBeenCalledTimes(2)

      state.tabsByWorktree = {
        'folder-1': [{ id: 'tab-future', worktreeId: 'folder-1', title: 'Codex' }]
      }
      expect(apply(unresolved)).toBe('applied')
      state.tabsByWorktree = {}
      expect(apply(unresolved)).toBe('pending')
      expect(track).toHaveBeenCalledTimes(3)
    }
  )

  it.each([null, 'remote-1'])('retains runtime-backed attribution on host %s', async (host) => {
    const { apply, state, track, enqueue, setAgentStatus } = await setup()
    state.repos = [{ id: 'repo-1', connectionId: host }]
    state.worktreesByRepo = { 'repo-1': [{ id: 'folder-1', repoId: 'repo-1' }] }
    expect(
      apply({ ...event, connectionId: host, worktreeId: 'folder-1', terminalHandle: 'terminal' })
    ).toBe('applied')
    expect(setAgentStatus).toHaveBeenCalledOnce()
    expect(track).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    expect(
      apply({
        ...event,
        connectionId: 'wrong-host',
        worktreeId: 'folder-1',
        terminalHandle: 'terminal'
      })
    ).toBe('dropped')
    expect(setAgentStatus).toHaveBeenCalledOnce()
  })
})
