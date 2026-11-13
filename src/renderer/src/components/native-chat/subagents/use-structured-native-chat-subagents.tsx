import type { AgentSessionCancelResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/structured-session-background-tasks-view'
import { NativeChatStructuredSessionStatus } from '../tools/tasks/NativeChatStructuredSessionStatus'
import { useStructuredSessionTaskStop } from '../tools/tasks/use-structured-session-task-stop'
import {
  closeNativeChatSubagentOnEscape,
  openNativeChatSubagent,
  useNativeChatOpenSubagent
} from './native-chat-open-subagent'
import { NativeChatStructuredSubagentStatusBar } from './NativeChatSubagentStatusBar'

/** A structured chat's agents strip and open subagent's bar, which share the strip's one Stop. */
export function useStructuredNativeChatSubagents({
  sessionId,
  paneKey,
  isVisible,
  controller
}: {
  sessionId: string
  paneKey: string
  isVisible: boolean
  controller: {
    subagentRoster?: StructuredAgentSubagentRoster
    backgroundTasks: StructuredSessionBackgroundTasksView
    stopBackgroundTask: (taskId?: string) => Promise<AgentSessionCancelResult | null>
  }
}) {
  const openId = useNativeChatOpenSubagent(paneKey)
  const stop = useStructuredSessionTaskStop(sessionId, controller)
  return {
    /** The subagent whose view replaces the conversation and the composer; null for none. */
    openId,
    onKeyDown: (event: React.KeyboardEvent) => closeNativeChatSubagentOnEscape(event, paneKey),
    strip: (
      <NativeChatStructuredSessionStatus
        sessionId={sessionId}
        paneKey={paneKey}
        isVisible={isVisible}
        backgroundTasks={controller.backgroundTasks}
        stop={stop}
      />
    ),
    statusBar:
      openId === null ? null : (
        <NativeChatStructuredSubagentStatusBar
          agentId={openId}
          entry={controller.subagentRoster?.get(openId)?.entry}
          paneKey={paneKey}
          backgroundTasks={controller.backgroundTasks}
          stop={stop}
          onBack={() => openNativeChatSubagent(paneKey, null)}
        />
      )
  }
}
