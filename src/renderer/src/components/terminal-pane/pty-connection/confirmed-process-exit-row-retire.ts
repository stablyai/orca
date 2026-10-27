import { useAppStore } from '@/store'
import type { RecognizedAgentProcess } from '../../../../../shared/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

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
  const entry = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
  if (
    !entry ||
    resolveCompatibleAgentTypeForOwner(entry.agentType, exited.agent) !== exited.agent
  ) {
    return
  }
  const armedAcceptedStatusSeq = entry.acceptedStatusSeq
  session.deferredCommandFinishedStatusDrop = () =>
    session.dropCommandFinishedStatusIfSameTurn(entry)
  session.deferredConfirmedShellReconcile = () =>
    session.reconcileEndedProcessIfPaneQuiet(armedAcceptedStatusSeq)
  // Why: a pane whose owner process the host can verify keeps the host's decision.
  session.settleDeferredCommandFinishedStatusDrop({ processExitConfirmed: true })
}
