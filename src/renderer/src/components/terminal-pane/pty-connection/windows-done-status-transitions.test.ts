import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { applyAgentStatusPatch } from '@/store/agent-status-patch'
import type { AgentStatusEntry } from '@/store/slices/agent-status-contract'
import { installWindowsDoneTerminalModeReset } from './pane-host-capability-flags'

const owner = getAgentStatusOwner(useAppStore)
const before = owner.getState()
afterEach(() => applyAgentStatusPatch(useAppStore, before))
it('resets Windows modes for an accepted completion even if recursive removal wins current state', () => {
  const key = 'windows:leaf'
  applyAgentStatusPatch(useAppStore, { agentStatusByPaneKey: {} })
  const reset = vi.fn(),
    suppress = vi.fn()
  const session: Parameters<typeof installWindowsDoneTerminalModeReset>[0] = {
    state: owner.getState(),
    cacheKey: key,
    paneStartup: null,
    suppressNativeWindowsIdleCodexFocusReports: false,
    setFocusReportSuppressionForAgentCompletion: suppress,
    queueAgentIdleTerminalModeReset: reset,
    unsubscribeWindowsDoneTerminalModeReset: null
  }
  installWindowsDoneTerminalModeReset(session)
  const row: AgentStatusEntry = {
    paneKey: key,
    agentType: 'codex',
    state: 'done',
    stateStartedAt: 10,
    updatedAt: 20,
    prompt: '',
    stateHistory: []
  }
  const off = useAppStore.subscribe(() => {
    if (owner.getEntry(key)?.state === 'done') {
      owner.transact((transaction) => transaction.setEntry(key, undefined))
      expect(reset).not.toHaveBeenCalled()
    }
  })
  owner.transact((transaction) => {
    transaction.setEntry(key, row)
    useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
  })
  off()
  expect(owner.getEntry(key)).toBeUndefined()
  expect(reset).toHaveBeenCalledTimes(1)
  expect(suppress).toHaveBeenCalledWith(undefined, 'codex')
  owner.transact((transaction) => transaction.setEntry(key, { ...row, stateStartedAt: 30 }))
  owner.transact((transaction) =>
    transaction.setEntry(key, { ...row, stateStartedAt: 30, updatedAt: 40 })
  )
  expect(reset).toHaveBeenCalledTimes(2)
  session.unsubscribeWindowsDoneTerminalModeReset?.()
  owner.transact((transaction) => transaction.setEntry(key, { ...row, stateStartedAt: 50 }))
  expect(reset).toHaveBeenCalledTimes(2)
})
