import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionCancelResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import type { StructuredPromptItem } from '../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { NativeChatStructuredSessionStatus } from '../tools/tasks/NativeChatStructuredSessionStatus'
import { useStructuredSessionTaskStop } from '../tools/tasks/use-structured-session-task-stop'
import { useWorkerDockColdSeed } from '../tools/tasks/dock/worker-dock-feed'
import { NativeChatStructuredDock } from './NativeChatStructuredDock'
import { useNativeChatOpenSubagent } from './native-chat-open-subagent'
import { NativeChatStructuredSubagentStop } from './NativeChatStructuredSubagentStop'
import { NativeChatSubagentSheetPromptSlot } from './NativeChatSubagentSheetLayer'
import { nativeChatWorkerApprovalParty } from '../worker-approvals/NativeChatWorkerApprovals'
import { NativeChatPairedServerAskStack } from '../paired-server-asks/NativeChatPairedServerAskStack'

/** A structured chat's agents strip and its subagent sheet, which share the strip's one Stop. */
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
    prompts: readonly StructuredPromptItem[]
    epoch: string | null
    contextClear: { clears: number }
  }
}) {
  const openId = useNativeChatOpenSubagent(paneKey)?.agentId ?? null
  const stop = useStructuredSessionTaskStop(sessionId, controller)
  const prompt = controller.prompts[0]
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
  const chip = isVisible ? (
    <NativeChatStructuredDock
      part="chip"
      hasWork={hasWork}
      strip={strip}
      target={target}
      party={party}
      isVisible={isVisible}
    />
  ) : null
  const approvals = isVisible ? (
    <NativeChatStructuredDock
      part="approvals"
      hasWork={hasWork}
      strip={strip}
      target={target}
      party={party}
      isVisible={isVisible}
    />
  ) : null
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
    /** The worker chip, for the transcript's end. */
    chip,
    /** Workers' open prompts, for the dock above the composer. */
    dock: approvals,
    /** Agents in this paired server's chat asking agents on this computer: answered here. */
    pairedAsks: <NativeChatPairedServerAskStack target={target} party={party} />
  }
}
