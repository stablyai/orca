import {
  AgentFlowNotificationDelivery,
  usesWholeFlowNotifications
} from '../../../shared/agent-flow-notification-policy'
import { terminalFlowNotificationState } from '../../../shared/terminal-flow-notification-state'
import { useAppStore } from '@/store'
import type { AgentCompletionStatusSnapshot } from '@/components/terminal-pane/agent-completion-coordinator-types'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'

export function createHookFlowNotificationDelivery(
  paneKey: string,
  worktreeId: string,
  readSnapshot: () => AgentCompletionStatusSnapshot | undefined,
  canDispatch: () => boolean
): AgentFlowNotificationDelivery {
  return new AgentFlowNotificationDelivery({
    read: () => {
      const snapshot = readSnapshot()
      if (
        !snapshot ||
        !canDispatch() ||
        !usesWholeFlowNotifications(
          useAppStore.getState().settings?.notifications?.agentNotificationMode,
          snapshot.agentType
        )
      ) {
        return null
      }
      return terminalFlowNotificationState(snapshot, paneKey, 'local')
    },
    deliver: (flowAlert) => {
      const snapshot = readSnapshot()
      if (snapshot) {
        dispatchTerminalNotification(worktreeId, {
          source: 'agent-task-complete',
          paneKey,
          agentStatusSnapshot: snapshot,
          terminalTitle: snapshot.agentType,
          flowAlert
        })
      }
    },
    setTimer: (run, delay) => {
      const timer = setTimeout(run, delay)
      return { cancel: () => clearTimeout(timer) }
    }
  })
}
