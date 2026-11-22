import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionCancelResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import { NativeChatStructuredSessionStatus } from '../tools/tasks/NativeChatStructuredSessionStatus'
import { useStructuredSessionTaskStop } from '../tools/tasks/use-structured-session-task-stop'
import { useTranslate } from '@/i18n/use-translate'
import { useWorkerDockColdSeed } from '../tools/tasks/dock/worker-dock-feed'
import { NativeChatStructuredDock } from './NativeChatStructuredDock'
import {
  backFromNativeChatSubagent,
  closeNativeChatSubagentOnEscape,
  useNativeChatOpenSubagent
} from './native-chat-open-subagent'
import { NativeChatStructuredSubagentStatusBar } from './NativeChatSubagentStatusBar'
import { nativeChatWorkerApprovalParty } from '../worker-approvals/NativeChatWorkerApprovals'
import { NativeChatPairedServerAskStack } from '../paired-server-asks/NativeChatPairedServerAskStack'

/** A structured chat's agents strip and open subagent's bar, which share the strip's one Stop. */
export function useStructuredNativeChatSubagents({
  sessionId,
  target,
  paneKey,
  isVisible,
  controller
}: {
  sessionId: string
  target: RuntimeClientTarget
  paneKey: string
  isVisible: boolean
  controller: {
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
  const background = controller.backgroundTasks
  useWorkerDockColdSeed(target, sessionId, isVisible, background.workerDock)
  const hasWork = Boolean(
    background.workerDock?.open ||
    background.tasks.length ||
    background.children?.length ||
    background.incomplete
  )
  const strip = (
    <NativeChatStructuredSessionStatus
      sessionId={sessionId}
      target={target}
      paneKey={paneKey}
      isVisible={isVisible}
      backgroundTasks={controller.backgroundTasks}
      stop={stop}
      currentAgentId={openId}
    />
  )
  const party = nativeChatWorkerApprovalParty({ sessionId })
  return {
    /** The subagent whose view replaces the conversation and the composer; null for none. */
    openId,
    onKeyDown: (event: React.KeyboardEvent) => closeNativeChatSubagentOnEscape(event, paneKey),
    dock: isVisible ? (
      <NativeChatStructuredDock
        hasWork={hasWork}
        strip={strip}
        target={target}
        party={party}
        isVisible={isVisible}
      />
    ) : null,
    /** Agents in this paired server's chat asking agents on this computer: answered here. */
    pairedAsks: <NativeChatPairedServerAskStack target={target} party={party} />,
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
