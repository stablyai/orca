import type { AgentStatusCacheIdentity } from '../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { isRetainedProgramResult } from '@/lib/program-status/row'
import { useAppStore } from '@/store/index'
import type { RecognizedAgentProcess } from '../../../../../../shared/agent-status/process/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../../shared/agent-status/title/agent-title-owner'
import { isRemoteExecutionHostPtyId } from '../../../../../../shared/execution-host/remote-execution-host-pty-id'

import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** Retire confirmed process exits even without OSC command marks, as in cmd.exe/Git Bash, which cannot arm a 133;D drop. */
export function retireLiveAgentRowOnConfirmedProcessExit(
  session: ConnectPanePtySession,
  exited: RecognizedAgentProcess
): void {
  const ptyId = session.transport.getPtyId()
  // Why: an armed 133;D drop owns its own confirming read, and a remote pane's host owns its rows.
  if (session.deferredCommandFinishedStatusDrop || !ptyId || isRemoteExecutionHostPtyId(ptyId)) {
    return
  }
  const entry = useAppStore.getState().agentStatusByPaneKey.get(session.cacheKey)
  if (
    !entry ||
    resolveCompatibleAgentTypeForOwner(entry.agentType, exited.agent) !== exited.agent
  ) {
    return
  }
  const armedAcceptedStatusSeq = entry.acceptedStatusSeq
  const identity = {
    paneKey: session.cacheKey,
    receivedAt: entry.updatedAt,
    stateStartedAt: entry.stateStartedAt
  }
  session.deferredCommandFinishedStatusDrop = () =>
    session.dropCommandFinishedStatusIfSameTurn(entry)
  session.deferredConfirmedShellReconcile = (processExitConfirmed?: boolean) =>
    session.reconcileEndedProcessIfPaneQuiet(armedAcceptedStatusSeq, processExitConfirmed, identity)
  // Why: a pane whose owner process the host can verify keeps the host's decision.
  session.settleDeferredCommandFinishedStatusDrop({ processExitConfirmed: true })
}

export function reconcileEndedProcessIfPaneQuiet(
  session: ConnectPanePtySession,
  armedAcceptedStatusSeq: number | undefined,
  processExitConfirmed?: boolean,
  identity?: AgentStatusCacheIdentity
): void {
  const current = useAppStore.getState().agentStatusByPaneKey.get(session.cacheKey)
  if (current && current.acceptedStatusSeq !== armedAcceptedStatusSeq) {
    return
  }
  // Why: main's clear echoes back and would drop the result the deferred drop just kept.
  if (current && isRetainedProgramResult(current)) {
    return
  }
  // Reconcile main-only hook latches retained by live-pane drops; renderer rows/config already belong to the deferred drop, and main echoes its clear.
  if (processExitConfirmed === true) {
    window.api?.agentStatus?.reconcileEndedProcess?.(session.cacheKey, true, identity)
  } else {
    window.api?.agentStatus?.reconcileEndedProcess?.(session.cacheKey)
  }
}
