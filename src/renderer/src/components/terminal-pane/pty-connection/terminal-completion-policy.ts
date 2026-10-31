import { clientOnlyUnverifiableInspection } from '../../../../../shared/terminal-process-inspection'
import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import {
  hookLaneOwnsAgentTurnEnds,
  hookLaneTitleTurnEndEvidence
} from '@/hooks/agent-hook-turn-end-ownership'
import { isFreshNonDoneAgentStatus } from '../../../../../shared/agent-status-types'
import { createAgentCompletionCoordinator } from '../agent-completion-coordinator'
import type { AgentCompletionCoordinatorOptions } from '../agent-completion-coordinator-types'
import type { createTerminalNotificationPolicy } from './terminal-notification-policy'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { dispatchAgentHookTerminalLifecycle } from '../agent-hook-terminal-lifecycle'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { isAgentTaskCompleteTrackingEnabled } from './agent-task-complete-settings'
import { isAgentProcessInspectionCostly } from '../agent-process-inspection-cost'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'

export function createTerminalCompletionPolicy(
  services: Pick<
    AgentCompletionCoordinatorOptions,
    'paneKey' | 'getPtyId' | 'getExpectedIncarnationId' | 'isLive' | 'onForegroundAgentExited'
  > & {
    captureForegroundRead?: () => () => boolean
    absorbBurstBellForHookOwnedIdle: () => void
    isVisible: () => boolean
    clearSuppressedTitleSideEffects: () => void
    setFocusReportSuppressionForAgentCompletion: (
      title: string | undefined,
      agentType: AgentType | undefined
    ) => void
    queueAgentIdleTerminalModeReset: () => void
    scheduleAgentTaskCompleteNotification: ReturnType<
      typeof createTerminalNotificationPolicy
    >['scheduleAgentTaskCompleteNotification']
  }
) {
  return createAgentCompletionCoordinator({
    paneKey: services.paneKey,
    statusLane: 'pty',
    getPtyId: services.getPtyId,
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: services.getExpectedIncarnationId,
    inspectProcess: async (ptyId, options) => {
      const current = services.captureForegroundRead?.()
      const result = await inspectRuntimeTerminalProcess(ptyId, options)
      return current?.() === false
        ? clientOnlyUnverifiableInspection('foreground_unconfirmed')
        : result
    },
    confirmForegroundProcess: async (ptyId) => {
      const current = services.captureForegroundRead?.()
      const result = await confirmRuntimeTerminalForegroundProcess(ptyId)
      return current?.() === false ? null : result
    },
    titleTurnEndEvidence: (title, foregroundAgent) =>
      hookLaneTitleTurnEndEvidence(services.paneKey, services.getPtyId(), title, foregroundAgent),
    onHookOwnedTitleIdle: services.absorbBurstBellForHookOwnedIdle,
    dispatchHookLifecycle: (payload) =>
      dispatchAgentHookTerminalLifecycle(services.paneKey, payload),
    shouldSuppressProcessReplacementCompletion: (exited, replacement) => {
      if (hookLaneOwnsAgentTurnEnds(services.paneKey, services.getPtyId(), exited.agent)) {
        return true
      }
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
      const currentAgentForReplacement = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        replacement.agent
      )
      return (
        isFreshNonDoneAgentStatus(currentStatus) && currentAgentForReplacement === replacement.agent
      )
    },
    shouldSuppressConfirmedProcessExitCompletion: (exited) => {
      if (hookLaneOwnsAgentTurnEnds(services.paneKey, services.getPtyId(), exited.agent)) {
        return true
      }
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
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
    onForegroundAgentExited: services.onForegroundAgentExited,
    dispatchCompletion: (title, meta) => {
      if (meta?.source === 'process-exit') {
        services.clearSuppressedTitleSideEffects()
      }
      if (meta?.terminalIdleConfirmed === true) {
        // Why: an agent can crash before its done hook; confirmed process death
        // must still restore cursor and native Windows Kitty keyboard modes.
        const currentAgentStatus = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
        if (!isFreshNonDoneAgentStatus(currentAgentStatus)) {
          services.setFocusReportSuppressionForAgentCompletion(title, meta.agentStatus?.agentType)
        }
        services.queueAgentIdleTerminalModeReset()
      }
      services.scheduleAgentTaskCompleteNotification(title, {
        allowDoneDetailAfterGrace: meta?.quietedHookDone,
        ...(meta?.source === 'process-exit' ? { agentCompletionSource: meta.source } : {}),
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) =>
      services.scheduleAgentTaskCompleteNotification(title, {
        agentStatusSnapshot: meta.agentStatus
      }),
    shouldPollProcessCadence: () => {
      const ptyId = services.getPtyId()
      if (isRemoteExecutionHostPtyId(ptyId)) {
        return false
      }
      return isAgentTaskCompleteTrackingEnabled() && services.isVisible()
    },
    shouldPollNoEvidenceProcessCadence: () => {
      const ptyId = services.getPtyId()
      return !isRemoteExecutionHostPtyId(ptyId)
    },
    isProcessInspectionCostly: () => isAgentProcessInspectionCostly(services.getPtyId()),
    isLive: services.isLive
  })
}
