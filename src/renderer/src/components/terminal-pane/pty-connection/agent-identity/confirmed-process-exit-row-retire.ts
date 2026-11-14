import { useAppStore } from '@/store/index'
import { isRetainedProgramResult } from '@/lib/program-status/row'
import { agentEntrySessionStartedAt } from '../../../../../../shared/agent-session/lifecycle/agent-session-start-time'
import type { RecognizedAgentProcess } from '../../../../../../shared/agent-status/process/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../../shared/agent-status/title/agent-title-owner'
import { isRemoteExecutionHostPtyId } from '../../../../../../shared/execution-host/remote-execution-host-pty-id'

import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** Suppress re-retention after confirmed shell return; existing same-turn and host checks still own live-row removal. */
export function retireConfirmedShellAgent(paneKey: string): void {
  const state = useAppStore.getState()
  const live = state.agentStatusByPaneKey[paneKey]
  const entry = live ?? state.retainedAgentsByPaneKey[paneKey]?.entry
  if (entry && isRetainedProgramResult(entry)) {
    return
  }
  const suppression = entry
    ? {
        run: {
          entry,
          agentType: entry.agentType ?? 'unknown',
          startedAt: agentEntrySessionStartedAt(entry)
        }
      }
    : {}
  if (live) {
    state.updateAgentStatusState((current) => ({
      retentionSuppressedPaneKeys: {
        ...current.retentionSuppressedPaneKeys,
        [paneKey]: suppression
      }
    }))
    return
  }
  // A pending retention sync can still hold the vanished live row.
  state.dropAgentStatus(paneKey, { suppressRetention: suppression, rendererOnly: true })
}

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
