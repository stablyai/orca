import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { confirmRuntimeTerminalForegroundProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import { useAppStore } from '@/store'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { mainAgentState } from '../../../../../shared/agent-status/lifecycle/main-agent-status'
import { isAgentForegroundProcess } from '../../../../../shared/agent-status/process/agent-process-recognition'
import { waitForPromiseWithSignal } from '../../../../../shared/concurrency/abort-signal-reason'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import {
  AGENT_SMART_KEY_STEP_MS,
  resolveAgentSmartKeys
} from '../../../../../shared/terminal/input/agent-smart-keys'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import { claimTerminalHandoffInterrupt } from './terminal-handoff-interrupt-claim'

export type TerminalContinuationInterrupt = (signal: AbortSignal) => Promise<boolean>

export function captureTerminalContinuationInterrupt(
  tabId: string,
  pane: ManagedPane,
  paneTransports: React.RefObject<Map<number, PtyTransport>>
): TerminalContinuationInterrupt | undefined {
  const paneKey = makePaneKey(tabId, pane.leafId)
  const original = useAppStore.getState().agentStatusByPaneKey.get(paneKey)
  const transport = paneTransports.current.get(pane.id)
  const ptyId = transport?.getPtyId()
  if (!transport || !ptyId || !original || !isTuiAgent(original.agentType)) {
    return undefined
  }
  const agent = original.agentType
  const writes = resolveAgentSmartKeys(agent, original)?.keys.find(
    (key) => key.name === 'stop'
  )?.writes
  const startedAt =
    original.turnStartedAt ?? original.mainAgent?.stateStartedAt ?? original.stateStartedAt
  const isCurrent = (): boolean => {
    const state = useAppStore.getState()
    const status = state.agentStatusByPaneKey.get(paneKey)
    return (
      paneTransports.current.get(pane.id) === transport &&
      transport.isConnected() &&
      !transport.isHoldingInput?.() &&
      transport.getExecutionHostId?.() === LOCAL_EXECUTION_HOST_ID &&
      transport.getPtyId() === ptyId &&
      state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[pane.leafId] === ptyId &&
      status?.agentType === agent &&
      status.orcaSessionId === original.orcaSessionId &&
      status.providerSession?.id === original.providerSession?.id &&
      !status.restoredUnconfirmed &&
      status.executionHost !== 'shared' &&
      mainAgentState(status) === 'working' &&
      status.workingMode !== 'monitoring' &&
      startedAt ===
        (status.turnStartedAt ?? status.mainAgent?.stateStartedAt ?? status.stateStartedAt)
    )
  }
  if (!writes || !isCurrent()) {
    return undefined
  }
  return async (signal) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(2_000)])
    for (const [index, write] of writes.entries()) {
      if (index > 0) {
        // Separate Escape presses so OpenCode reads two keys instead of Alt+Escape.
        await new Promise<void>((resolve) => window.setTimeout(resolve, AGENT_SMART_KEY_STEP_MS))
      }
      if (deadline.aborted || !isCurrent()) {
        return false
      }
      const process = await waitForPromiseWithSignal(
        confirmRuntimeTerminalForegroundProcess(ptyId),
        deadline
      )
      if (deadline.aborted || !isCurrent() || !isAgentForegroundProcess(process, agent)) {
        return false
      }
      if (index === 0 && !claimTerminalHandoffInterrupt(transport, { ptyId, startedAt })) {
        return true
      }
      if (
        !(await sendRuntimePtyInputVerified(ptyId, write, 'driving', {
          requireWriteSettlement: true
        }))
      ) {
        return false
      }
    }
    return true
  }
}
