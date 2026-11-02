import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildStoreState, type StoreLike } from '../ipc-events-agent-status-store-test-fixtures'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

const mocks = vi.hoisted(() => {
  const state: { current: StoreLike | null } = { current: null }
  return { observe: vi.fn(), state }
})

vi.mock('../../store', () => ({
  useAppStore: { getState: () => mocks.state.current }
}))
vi.mock('../agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observe
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

import { createAgentStatusEventApplicator } from './agent-status-event-applicator'

function status(over: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    state: 'done',
    prompt: 'ship it',
    agentType: 'claude',
    receivedAt: 1_700_000_005_000,
    stateStartedAt: 1_700_000_000_000,
    ...over
  }
}

function createApplicator(): (data: AgentStatusIpcPayload) => unknown {
  return createAgentStatusEventApplicator({
    pendingAgentStatusEvents: [],
    transientClearWatermarkByConnectionId: new Map(),
    enqueuePendingAgentStatus: vi.fn()
  })
}

// A relay reconnect re-sends every cached row; each replayed `done` used to notify again.
describe('live agent-status replay notifications', () => {
  let setAgentStatus: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mocks.observe.mockReset()
    setAgentStatus = vi.fn()
    mocks.state.current = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Claude' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: LEAF_ID }
      }
    })
  })

  it('updates status from a replayed done without observing it as a completion', () => {
    const apply = createApplicator()

    expect(apply(status({ isReplay: true }))).toBe('applied')

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(mocks.observe).not.toHaveBeenCalled()
  })

  function seedRow(row: { state: string; stateStartedAt: number }): void {
    const current = mocks.state.current
    if (current) {
      current.agentStatusByPaneKey = {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          worktreeId: 'wt-1',
          connectionId: null,
          agentType: 'claude',
          updatedAt: 1_700_000_001_000,
          ...row
        }
      }
    }
  }

  it('notifies for a replayed done that finished while the host was unreachable', () => {
    seedRow({ state: 'working', stateStartedAt: 1_699_999_000_000 })
    const apply = createApplicator()

    expect(apply(status({ isReplay: true }))).toBe('applied')

    expect(mocks.observe).toHaveBeenCalledTimes(1)
    expect(mocks.observe.mock.calls[0][0]).not.toHaveProperty('seedOnly')
    expect(mocks.observe.mock.calls[0][0].payload).toHaveProperty('state', 'done')
  })

  it('does not observe a replay of the done this renderer already shows', () => {
    seedRow({ state: 'done', stateStartedAt: 1_700_000_000_000 })
    const apply = createApplicator()

    expect(apply(status({ isReplay: true }))).toBe('applied')

    expect(mocks.observe).not.toHaveBeenCalled()
  })

  it('observes a replayed working row whose turn completed while the host was unreachable', () => {
    seedRow({ state: 'working', stateStartedAt: 1_700_000_000_000 })
    const apply = createApplicator()

    apply(status({ state: 'working', isReplay: true, turnCompletedAt: 1_700_000_004_000 }))

    expect(mocks.observe).toHaveBeenCalledTimes(1)
    expect(mocks.observe.mock.calls[0][0]).not.toHaveProperty('seedOnly')
    expect(mocks.observe.mock.calls[0][0].payload).toHaveProperty(
      'turnCompletedAt',
      1_700_000_004_000
    )
  })
})
