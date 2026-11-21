import { useContext } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionCancelResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import { NativeChatStructuredSessionStatus } from '../tools/tasks/NativeChatStructuredSessionStatus'
import { useStructuredSessionTaskStop } from '../tools/tasks/use-structured-session-task-stop'
import { useTranslate } from '@/i18n/use-translate'
import { useWorkerDockColdSeed } from '../tools/tasks/dock/worker-dock-feed'
import { NativeChatWorkerDockFrame } from '../tools/tasks/dock/NativeChatWorkerDockFrame'
import {
  backFromNativeChatSubagent,
  closeNativeChatSubagentOnEscape,
  useNativeChatOpenSubagent
} from './native-chat-open-subagent'
import { NativeChatStructuredSubagentStatusBar } from './NativeChatSubagentStatusBar'
import {
  NativeChatPartyWorkerApprovalStack,
  nativeChatWorkerApprovalParty
} from '../worker-approvals/NativeChatWorkerApprovals'
import {
  NativeChatCrewContext,
  useNativeChatCrew
} from '../../orchestration-crew/use-native-chat-crew'

/** Shows the dock while the chat has work, or a crew (the suspended crew panel's strip) to show. */
function NativeChatStructuredDock(props: { hasWork: boolean; children: React.ReactNode }) {
  const crew = useNativeChatCrew(useContext(NativeChatCrewContext))
  return props.hasWork || crew ? (
    <NativeChatWorkerDockFrame>{props.children}</NativeChatWorkerDockFrame>
  ) : null
}

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
  return {
    /** The subagent whose view replaces the conversation and the composer; null for none. */
    openId,
    onKeyDown: (event: React.KeyboardEvent) => closeNativeChatSubagentOnEscape(event, paneKey),
    dock: isVisible ? (
      <NativeChatStructuredDock hasWork={hasWork}>
        {strip}
        <NativeChatPartyWorkerApprovalStack
          party={nativeChatWorkerApprovalParty({ sessionId })}
          target={target}
          isVisible={isVisible}
        />
      </NativeChatStructuredDock>
    ) : null,
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
