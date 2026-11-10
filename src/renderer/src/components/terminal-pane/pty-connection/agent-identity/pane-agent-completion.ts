import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { isFreshNonDoneAgentStatus } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import { createAgentCompletionCoordinator } from '../../agent-completion/agent-completion-coordinator'
import { dispatchAgentHookTerminalLifecycle } from '../../agent-completion/agent-hook-terminal-lifecycle'
import {
  hookLaneOwnsAgentTurnEnds,
  hookLaneTitleTurnEndEvidence
} from '@/hooks/agent-hook-turn-end-ownership'
import { absorbBurstBellForHookOwnedIdle } from '../notifications/agent-task-complete-notify'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../../shared/agent-status/title/agent-title-owner'
import { isAgentTaskCompleteTrackingEnabled } from '../notifications/agent-task-complete-settings'
import { isAgentProcessInspectionCostly } from '../../agent-completion/process-inspection/agent-process-inspection-cost'
import { isRemoteExecutionHostPtyId } from '../../../../../../shared/execution-host/remote-execution-host-pty-id'
import { retireLiveAgentRowOnConfirmedProcessExit } from './confirmed-process-exit-row-retire'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installPaneAgentCompletion(session: ConnectPanePtySession): void {
  session.agentCompletionCoordinator = createAgentCompletionCoordinator({
    paneKey: session.cacheKey,
    statusLane: 'pty',
    getPtyId: () => session.transport.getPtyId(),
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: () => session.remotePtyIncarnationId ?? null,
    inspectProcess: inspectRuntimeTerminalProcess,
    confirmForegroundProcess: confirmRuntimeTerminalForegroundProcess,
    dispatchHookLifecycle: (payload) =>
      dispatchAgentHookTerminalLifecycle(session.cacheKey, payload),
    titleTurnEndEvidence: (title, foregroundAgent) =>
      hookLaneTitleTurnEndEvidence(
        session.cacheKey,
        session.transport.getPtyId(),
        title,
        foregroundAgent
      ),
    onHookOwnedTitleIdle: () => absorbBurstBellForHookOwnedIdle(session),
    shouldSuppressProcessReplacementCompletion: (exited, replacement) => {
      // Why: the hook lane owns this pane's turn ends and its last turn ended, so quitting ends none.
      if (hookLaneOwnsAgentTurnEnds(session.cacheKey, session.transport.getPtyId(), exited.agent)) {
        return true
      }
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      const currentAgentForReplacement = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        replacement.agent
      )
      return (
        isFreshNonDoneAgentStatus(currentStatus) && currentAgentForReplacement === replacement.agent
      )
    },
    shouldSuppressConfirmedProcessExitCompletion: (exited) => {
      if (hookLaneOwnsAgentTurnEnds(session.cacheKey, session.transport.getPtyId(), exited.agent)) {
        return true
      }
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      const currentAgentForExited = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        exited.agent
      )
      // Why: a replacement hook can lead process visibility by one cadence;
      // only a different known active owner can veto confirmed old-process exit.
      return Boolean(
        isFreshNonDoneAgentStatus(currentStatus) &&
        currentStatus.agentType &&
        currentStatus.agentType !== 'unknown' &&
        currentAgentForExited !== exited.agent
      )
    },
    // Why: the pane's only re-derivation of a process read where the shell emits no command marks.
    onForegroundAgentExited: (exited) => {
      session.paneForegroundAgentTracker?.onProcessExitConfirmed(exited)
      // Why: not behind the tracker's process-read guard, so hook-identified panes retire too.
      retireLiveAgentRowOnConfirmedProcessExit(session, exited)
    },
    dispatchCompletion: (title, meta) => {
      if (meta?.source === 'process-exit') {
        session.clearSuppressedTitleSideEffects()
      }
      if (meta?.terminalIdleConfirmed === true) {
        // Why: an agent can crash before its done hook; confirmed process death
        // must still restore cursor and native Windows Kitty keyboard modes.
        const currentAgentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
        if (!isFreshNonDoneAgentStatus(currentAgentStatus)) {
          session.setFocusReportSuppressionForAgentCompletion(title, meta.agentStatus?.agentType)
        }
        session.queueAgentIdleTerminalModeReset()
      }
      session.scheduleAgentTaskCompleteNotification(title, {
        allowDoneDetailAfterGrace: meta?.quietedHookDone,
        ...(meta?.source === 'process-exit' ? { agentCompletionSource: meta.source } : {}),
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) =>
      session.scheduleAgentTaskCompleteNotification(title, {
        agentStatusSnapshot: meta.agentStatus
      }),
    shouldPollProcessCadence: () => {
      const ptyId = session.transport.getPtyId()
      if (isRemoteExecutionHostPtyId(ptyId)) {
        return false
      }
      return isAgentTaskCompleteTrackingEnabled() && session.deps.isVisibleRef.current
    },
    shouldPollNoEvidenceProcessCadence: () => {
      const ptyId = session.transport.getPtyId()
      return !isRemoteExecutionHostPtyId(ptyId)
    },
    isProcessInspectionCostly: () => isAgentProcessInspectionCostly(session.transport.getPtyId()),
    isLive: () => {
      if (session.disposed) {
        return false
      }
      if (session.transport.getPtyId()) {
        return true
      }
      return (useAppStore.getState().ptyIdsByTabId[session.deps.tabId] ?? []).length > 0
    }
  })
}
