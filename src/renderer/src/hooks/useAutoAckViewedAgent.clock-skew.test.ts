// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoAckViewedAgent } from './useAutoAckViewedAgent'
import { useAppStore } from '../store'
import { makeTab } from '../store/slices/store-test-helpers'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'

// Why: the hook re-scans on every store write and advances its diff refs to the PRE-write snapshot,
// so its ref guard never suppresses the rescan an ack triggers. It only terminated because
// acknowledgeAgents returned the same object within one millisecond — a scan costing >=1ms with a
// turn stamped ahead of the local clock (SSH/remote host) re-acked forever (React #185).

const TAB_ID = 'tab-main'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const NOW = new Date('2026-06-02T12:00:00Z').getTime()
const SKEW_MS = 90_000
const ACK_CALL_CEILING = 20

function seedFutureStampedTurn(stateStartedAt: number): void {
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: 'remote turn',
    updatedAt: stateStartedAt,
    stateStartedAt,
    agentType: 'codex',
    paneKey: PANE_KEY,
    stateHistory: []
  }
  useAppStore.setState({
    activeView: 'terminal',
    activeTabId: TAB_ID,
    activeWorktreeId: 'wt-1',
    activeTabIdByWorktree: {},
    tabsByWorktree: { 'wt-1': [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })] },
    terminalLayoutsByTabId: {
      [TAB_ID]: { root: null, activeLeafId: LEAF_ID, expandedLeafId: null }
    },
    agentStatusByPaneKey: { [PANE_KEY]: entry },
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    unreadAgentCompletionPanes: {},
    unreadTerminalTabs: {}
  })
}

/** Wraps the real action, then circuit-breaks so a regression fails the assertion instead of hanging. */
function instrumentAcknowledgeAgents(): string[][] {
  const real = useAppStore.getState().acknowledgeAgents
  const calls: string[][] = []
  useAppStore.setState({
    acknowledgeAgents: (paneKeys: string[]) => {
      calls.push(paneKeys)
      if (calls.length > ACK_CALL_CEILING) {
        return
      }
      real(paneKeys)
    }
  })
  return calls
}

describe('useAutoAckViewedAgent — clock-skewed execution host', () => {
  let realAcknowledgeAgents: (paneKeys: string[]) => void

  beforeEach(() => {
    realAcknowledgeAgents = useAppStore.getState().acknowledgeAgents
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    // Why a ticking clock: the loop self-terminated only while Date.now() stayed on one millisecond.
    let clock = NOW
    vi.spyOn(Date, 'now').mockImplementation(() => clock++)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useAppStore.setState({ acknowledgeAgents: realAcknowledgeAgents })
  })

  it('acks a turn stamped ahead of the local clock exactly once', () => {
    seedFutureStampedTurn(NOW + SKEW_MS)
    const calls = instrumentAcknowledgeAgents()

    renderHook(() => useAutoAckViewedAgent(false))

    expect(calls).toEqual([[PANE_KEY]])
    const ackAt = useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_KEY] ?? 0
    expect(ackAt).toBeGreaterThanOrEqual(NOW + SKEW_MS)
  })

  it('leaves nothing to re-scan for a future-stamped turn on the next store write', () => {
    seedFutureStampedTurn(NOW + SKEW_MS)
    renderHook(() => useAutoAckViewedAgent(false))

    const calls = instrumentAcknowledgeAgents()
    useAppStore.getState().markTerminalTabUnread('tab-unrelated')

    expect(calls).toEqual([])
  })

  it('still acks a normally stamped turn once', () => {
    seedFutureStampedTurn(NOW - 5_000)
    const calls = instrumentAcknowledgeAgents()

    renderHook(() => useAutoAckViewedAgent(false))

    expect(calls).toEqual([[PANE_KEY]])
  })

  it('keeps an explicitly marked-unread visible turn unread', () => {
    seedFutureStampedTurn(NOW - 5_000)
    useAppStore.getState().acknowledgeAgents([PANE_KEY])

    renderHook(() => useAutoAckViewedAgent(false))
    useAppStore.getState().unacknowledgeAgents([PANE_KEY])

    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
  })
})
