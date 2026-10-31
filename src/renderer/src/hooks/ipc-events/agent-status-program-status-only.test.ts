import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { ProgramStatusFacet } from '../../../../shared/program-status/facet'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildStoreState, type StoreLike } from '../ipc-events-agent-status-store-test-fixtures'
import type { PendingAgentStatusEvent } from './agent-status-bridge-types'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const FACET: ProgramStatusFacet = { state: 'blocked', kind: 'auth', observedAt: 1 }

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

describe('agent-status programStatus ingest', () => {
  let setAgentStatus: ReturnType<typeof vi.fn>
  let setAgentProgramStatus: ReturnType<typeof vi.fn>
  let pending: PendingAgentStatusEvent[]

  function createApplicator(): (data: AgentStatusIpcPayload) => unknown {
    return createAgentStatusEventApplicator({
      pendingAgentStatusEvents: pending,
      transientClearWatermarkByConnectionId: new Map(),
      enqueuePendingAgentStatus: vi.fn()
    })
  }

  beforeEach(() => {
    mocks.observe.mockReset()
    pending = []
    setAgentStatus = vi.fn()
    setAgentProgramStatus = vi.fn(() => true)
    mocks.state.current = buildStoreState({
      setAgentStatus,
      setAgentProgramStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Claude' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: LEAF_ID }
      },
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          worktreeId: 'wt-1',
          connectionId: null,
          agentType: 'claude',
          state: 'working',
          stateStartedAt: 1_699_999_000_000,
          updatedAt: 1_700_000_009_000
        }
      }
    })
  })

  it('patches only the facet for a facet-only republish, even with an older receivedAt', () => {
    const apply = createApplicator()

    expect(apply(status({ programStatus: FACET, programStatusOnly: true }))).toBe('applied')

    expect(setAgentProgramStatus).toHaveBeenCalledWith(PANE_KEY, FACET)
    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(mocks.observe).not.toHaveBeenCalled()
  })

  it('keeps the pending state row of a known pane when a facet tick lands', () => {
    pending.push({ data: status({}), firstSeenAt: 0, replay: false })
    const apply = createApplicator()

    expect(apply(status({ programStatus: FACET, programStatusOnly: true }))).toBe('applied')

    expect(pending).toHaveLength(1)
  })

  it('folds a facet-only republish for an unknown pane into its pending row instead of queueing', () => {
    const otherPane = makePaneKey('tab-9', LEAF_ID)
    pending.push({
      data: status({ paneKey: otherPane, tabId: 'tab-9' }),
      firstSeenAt: 0,
      replay: false
    })
    const apply = createApplicator()

    expect(
      apply(
        status({
          paneKey: otherPane,
          tabId: 'tab-9',
          programStatus: FACET,
          programStatusOnly: true
        })
      )
    ).toBe('dropped')

    expect(pending).toHaveLength(1)
    expect(pending[0].data.programStatus).toEqual(FACET)
    expect(setAgentProgramStatus).not.toHaveBeenCalled()

    apply(status({ paneKey: otherPane, tabId: 'tab-9', programStatusOnly: true }))
    expect(pending[0].data).not.toHaveProperty('programStatus')
  })
})
