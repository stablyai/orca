// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentAutoAckPresence from './agent-auto-ack-presence'
import { useReadOnScreenAttention } from './useReadOnScreenAttention'
import { useAppStore } from '../store'
import { makeTab, makeTabGroup, makeUnifiedTab } from '../store/slices/store-session-test-harness'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'

// Synchronous ack re-entry once repeated forever when remote turn time led local clock and scans crossed millisecond boundaries (React #185); slice guards retained pre-write snapshots.

vi.mock('./agent-auto-ack-presence', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentAutoAckPresence>()),
  createAutoAckPresenceCheck: (_read: unknown, onPresent: () => void) => ({
    request: onPresent,
    dispose() {}
  })
}))

const TAB_ID = 'tab-main'
const GROUP_ID = 'group-main'
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
    activeTabIdByWorktree: { 'wt-1': TAB_ID },
    activeGroupIdByWorktree: { 'wt-1': GROUP_ID },
    tabsByWorktree: { 'wt-1': [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })] },
    unifiedTabsByWorktree: {
      'wt-1': [makeUnifiedTab({ id: TAB_ID, worktreeId: 'wt-1', groupId: GROUP_ID })]
    },
    groupsByWorktree: {
      'wt-1': [
        makeTabGroup({ id: GROUP_ID, worktreeId: 'wt-1', activeTabId: TAB_ID, tabOrder: [TAB_ID] })
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
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

describe('useReadOnScreenAttention — clock-skewed execution host', () => {
  let realAcknowledgeAgents: (paneKeys: string[]) => void

  beforeEach(() => {
    realAcknowledgeAgents = useAppStore.getState().acknowledgeAgents
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    // Advance Date.now: frozen single-millisecond time would hide the ack loop.
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

    renderHook(() => useReadOnScreenAttention())

    expect(calls).toEqual([[PANE_KEY]])
    const ackAt = useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_KEY] ?? 0
    expect(ackAt).toBeGreaterThanOrEqual(NOW + SKEW_MS)
  })

  it('leaves nothing to re-scan for a future-stamped turn on the next store write', () => {
    seedFutureStampedTurn(NOW + SKEW_MS)
    renderHook(() => useReadOnScreenAttention())

    const calls = instrumentAcknowledgeAgents()
    useAppStore.setState((state) => ({
      unreadTerminalTabs: { ...state.unreadTerminalTabs, 'tab-unrelated': 'terminal-bell' }
    }))

    expect(calls).toEqual([])
  })

  it('keeps an explicitly marked-unread visible turn unread', () => {
    seedFutureStampedTurn(NOW - 5_000)
    useAppStore.getState().acknowledgeAgents([PANE_KEY])

    renderHook(() => useReadOnScreenAttention())
    useAppStore.getState().unacknowledgeAgents([PANE_KEY])

    expect(useAppStore.getState().acknowledgedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
  })
})
