import type { AgentSessionCancelResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/structured-session-background-tasks-view'
import { NativeChatStructuredSessionStatus } from '../tools/tasks/NativeChatStructuredSessionStatus'
import { useStructuredSessionTaskStop } from '../tools/tasks/use-structured-session-task-stop'
import type { StructuredPromptItem } from '../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { useNativeChatOpenSubagent } from './native-chat-open-subagent'
import { NativeChatStructuredSubagentStop } from './NativeChatStructuredSubagentStop'
import { NativeChatSubagentSheetPromptSlot } from './NativeChatSubagentSheetLayer'

/** A structured chat's agents strip and its subagent sheet, which share the strip's one Stop. */
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
    prompts: readonly StructuredPromptItem[]
    epoch: string | null
    contextClear: { clears: number }
  }
}) {
  const openId = useNativeChatOpenSubagent(paneKey)?.agentId ?? null
  const stop = useStructuredSessionTaskStop(sessionId, controller)
  const prompt = controller.prompts[0]
  return {
    layer: {
      paneKey,
      // A rewind or a /clear replaces the conversation, which closes the sheet like a new session.
      sessionKey: `${sessionId}:${controller.epoch}:${controller.contextClear.clears}`,
      stop:
        openId === null ? undefined : (
          <NativeChatStructuredSubagentStop
            agentId={openId}
            paneKey={paneKey}
            backgroundTasks={controller.backgroundTasks}
            stop={stop}
          />
        ),
      waiting: prompt === undefined ? undefined : (prompt.agentId ?? null)
    },
    /** Draws the chat's prompt card in the open subagent's sheet when that subagent is the one waiting. */
    promptSlot: (card: React.ReactNode) => (
      <NativeChatSubagentSheetPromptSlot agentId={prompt?.agentId}>
        {card}
      </NativeChatSubagentSheetPromptSlot>
    ),
    strip: (
      <NativeChatStructuredSessionStatus
        sessionId={sessionId}
        paneKey={paneKey}
        isVisible={isVisible}
        backgroundTasks={controller.backgroundTasks}
        stop={stop}
        currentAgentId={openId}
      />
    )
  }
}
