import { captureNotificationTransportOwner } from '@/attention/notification-subject-owner'
import { AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS } from '../../notifications/agent-task-complete-policy'
import { hasPendingHookLaneCompletion } from '@/hooks/agent-hook-completion-notifications'
import {
  isAgentTaskCompleteNotificationEnabled,
  isAgentTaskCompleteTrackingEnabled
} from './agent-task-complete-settings'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installTerminalBellCompletionArbitration(session: ConnectPanePtySession): void {
  // BEL raises attention and OS notification; replay resets stale focus-report modes so shell clicks cannot generate false bells (shared/terminal-mode-reset-profiles.ts).
  session.onBell = (): void => {
    // Treat standalone restored-session BEL as authoritative output; any suppression belongs in explicit notification policy.
    session.deps.markTerminalBell({
      worktreeId: session.deps.worktreeId,
      tabId: session.deps.tabId,
      paneKey: session.cacheKey
    })
    // Delay BEL’s OS notice so a same-burst title completion can win the shared cooldown.
    if (session.hookOwnedIdleAbsorbsBell === true) {
      return
    }
    session.pendingTerminalBellNotification = true
    if (!session.hasPendingAgentTaskCompleteNotification()) {
      session.scheduleTerminalBellNotification()
    }
  }

  session.clearTerminalBellNotificationTimer = (): void => {
    if (session.terminalBellNotificationTimer !== null) {
      clearTimeout(session.terminalBellNotificationTimer)
      session.terminalBellNotificationTimer = null
    }
  }

  session.scheduleTerminalBellNotification = (): void => {
    if (session.terminalBellNotificationTimer !== null) {
      return
    }
    session.terminalBellNotificationTimer = setTimeout(() => {
      session.terminalBellNotificationTimer = null
      if (session.disposed) {
        session.pendingTerminalBellNotification = false
        return
      }
      if (session.hasPendingAgentTaskCompleteNotification()) {
        return
      }
      session.pendingTerminalBellNotification = false
      // Why: the hook lane's pending Done announces this burst's turn end, superseding the BEL as a pane completion does.
      if (
        isAgentTaskCompleteNotificationEnabled() &&
        hasPendingHookLaneCompletion(session.cacheKey, session.transport.getPtyId())
      ) {
        return
      }
      session.deps.dispatchNotification({
        source: 'terminal-bell',
        paneKey: session.cacheKey,
        ptyId: session.transport.getPtyId(),
        workspaceOwner: captureNotificationTransportOwner(session.transport)
      })
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
  }

  session.hasPendingAgentTaskCompleteNotification = (): boolean =>
    isAgentTaskCompleteNotificationEnabled() &&
    (session.agentCompletionCoordinator.hasPendingHookDoneCompletion() ||
      session.agentTaskCompleteNotificationGraceTimer !== null ||
      session.agentTaskCompleteNotificationMaxTimer !== null ||
      session.agentTaskCompleteStatusUnsubscribe !== null)

  session.clearPendingAgentTaskCompleteNotification = (): void => {
    if (session.agentTaskCompleteNotificationGraceTimer !== null) {
      clearTimeout(session.agentTaskCompleteNotificationGraceTimer)
      session.agentTaskCompleteNotificationGraceTimer = null
    }
    if (session.agentTaskCompleteNotificationMaxTimer !== null) {
      clearTimeout(session.agentTaskCompleteNotificationMaxTimer)
      session.agentTaskCompleteNotificationMaxTimer = null
    }
    session.hookOwnedIdleAbsorbsBell = false
    if (session.agentTaskCompleteStatusUnsubscribe !== null) {
      session.agentTaskCompleteStatusUnsubscribe()
      session.agentTaskCompleteStatusUnsubscribe = null
    }
  }

  session.syncAgentTaskCompleteTrackingEnabled = (): boolean => {
    const enabled = isAgentTaskCompleteTrackingEnabled()
    const osNotificationsEnabled = isAgentTaskCompleteNotificationEnabled()
    if (
      !osNotificationsEnabled &&
      session.wasAgentTaskCompleteOsNotificationEnabled &&
      session.pendingTerminalBellNotification
    ) {
      session.scheduleTerminalBellNotification()
    }
    if (!enabled && session.wasAgentTaskCompleteTrackingEnabled) {
      // Disabling all completion consumers drops pending alerts but preserves accepted-hook lifecycle state.
      session.agentTaskCompleteNotificationGeneration += 1
      session.requiresFreshWorkingForAgentTaskCompleteNotification = true
      session.clearPendingAgentTaskCompleteNotification()
      if (session.pendingTerminalBellNotification) {
        session.scheduleTerminalBellNotification()
      }
    } else if (enabled && !session.wasAgentTaskCompleteTrackingEnabled) {
      // Require fresh work after re-enable so an idle event cannot announce work observed while notifications were disabled.
      session.requiresFreshWorkingForAgentTaskCompleteNotification = true
    }
    session.wasAgentTaskCompleteTrackingEnabled = enabled
    session.wasAgentTaskCompleteOsNotificationEnabled = osNotificationsEnabled
    return enabled
  }
}
