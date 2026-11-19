import type { AgentSessionCancelResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import { NativeChatStructuredSessionStatus } from '../tools/tasks/NativeChatStructuredSessionStatus'
import { useStructuredSessionTaskStop } from '../tools/tasks/use-structured-session-task-stop'
import { useTranslate } from '@/i18n/use-translate'
import {
  backFromNativeChatSubagent,
  closeNativeChatSubagentOnEscape,
  useNativeChatOpenSubagent
} from './native-chat-open-subagent'
import { NativeChatStructuredSubagentStatusBar } from './NativeChatSubagentStatusBar'
import { ZotzBackgroundTasksPortal } from '@/components/zotz/background/ZotzBackgroundTasksPortal'
import { useZotzChatTaskOutputs } from '@/components/zotz/background/use-zotz-chat-task-outputs'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'

/** A structured chat's agents strip and open subagent's bar, which share the strip's one Stop. */
export function useStructuredNativeChatSubagents({
  sessionId,
  paneKey,
  isVisible,
  isFocusedGroup,
  tabId,
  controller
}: {
  sessionId: string
  paneKey: string
  isVisible: boolean
  /** Zotz: only the visible, focused pane fills the right sidebar's Background panel. */
  isFocusedGroup?: boolean
  /** Zotz: the chat's tab, whose worktree owns its shells' output files. */
  tabId: string
  controller: {
    messages?: readonly NativeChatMessage[]
    subagentRoster?: StructuredAgentSubagentRoster
    backgroundTasks: StructuredSessionBackgroundTasksView
    stopBackgroundTask: (taskId?: string) => Promise<AgentSessionCancelResult | null>
  }
}) {
  const t = useTranslate()
  const open = useNativeChatOpenSubagent(paneKey)
  const openId = open?.agentId ?? null
  const parentId = open?.parentId ?? null
  const stop = useStructuredSessionTaskStop(sessionId, controller)
  const taskOutputs = useZotzChatTaskOutputs(tabId, controller.messages)
  return {
    /** The subagent whose view replaces the conversation and the composer; null for none. */
    openId,
    onKeyDown: (event: React.KeyboardEvent) => closeNativeChatSubagentOnEscape(event, paneKey),
    // Zotz: background work shows in the right sidebar's Background tab, not above the chat.
    strip: (
      <ZotzBackgroundTasksPortal
        active={isVisible && isFocusedGroup !== false}
        outputs={taskOutputs}
      >
        <NativeChatStructuredSessionStatus
          sessionId={sessionId}
          paneKey={paneKey}
          isVisible={isVisible}
          backgroundTasks={controller.backgroundTasks}
          stop={stop}
          currentAgentId={openId}
        />
      </ZotzBackgroundTasksPortal>
    ),
    statusBar:
      openId === null ? null : (
        <NativeChatStructuredSubagentStatusBar
          agentId={openId}
          entry={controller.subagentRoster?.get(openId)?.entry}
          paneKey={paneKey}
          backgroundTasks={controller.backgroundTasks}
          stop={stop}
          backTo={
            parentId === null
              ? undefined
              : (controller.subagentRoster?.get(parentId)?.entry.label ??
                t('components.native-chat.subagents.unnamed', 'Subagent'))
          }
          onBack={() => backFromNativeChatSubagent(paneKey)}
        />
      )
  }
}
