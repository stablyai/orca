import { projectedStructuredChatTabName } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { structuredChatTabById } from '../tab-identity/structured-chat-tab-index'
import {
  deriveRunningAgentSendTargets,
  deriveStatuslessStructuredAgentSendTargets,
  runningAgentMessageTarget
} from './running-agent-targets'
import type { RunningAgentSendTarget, RunningAgentTargetState } from './running-agent-targets'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AppState } from '@/store/types'
import type { AgentMessageTarget } from './agent-message-target'

export type NotesSendAgentTargetState = RunningAgentTargetState &
  Pick<AppState, 'runtimePaneTitlesByTabId'>

export type NotesSendAgentTarget = {
  paneKey: string
  tabId: string
  messageTarget: AgentMessageTarget
  agentType: AgentType | null | undefined
  tabTitle: string
  status: 'eligible' | 'disabled'
  disabledReason?: string
}

/** Running agents plus first-turn chats, which only the notes menu lists. */
export function deriveNotesSendAgentTargets(
  state: NotesSendAgentTargetState,
  worktreeId: string,
  chatNames: StructuredChatTabNames
): NotesSendAgentTarget[] {
  return [
    ...deriveRunningAgentSendTargets(state, worktreeId),
    ...deriveStatuslessStructuredAgentSendTargets(state, worktreeId)
  ].map((target) => {
    const tab = structuredChatTabById(state.unifiedTabsByWorktree, worktreeId, target.tabId)
    const title =
      target.kind === 'structured-session' && tab?.entityId === target.sessionId
        ? projectedStructuredChatTabName(tab, chatNames)
        : undefined
    return toNotesSendAgentTarget(target, title)
  })
}

function toNotesSendAgentTarget(
  target: RunningAgentSendTarget,
  title?: string
): NotesSendAgentTarget {
  return {
    paneKey: target.paneKey,
    tabId: target.tabId,
    messageTarget: runningAgentMessageTarget(target),
    agentType:
      target.kind === 'terminal'
        ? resolveNotesTargetAgentType(target.entry.agentType, target.tab.launchAgent)
        : target.agentType,
    tabTitle: target.kind === 'terminal' ? target.tab.title : (title ?? target.title),
    status: target.status,
    ...(target.disabledReason ? { disabledReason: target.disabledReason } : {})
  }
}

function resolveNotesTargetAgentType(
  entryAgentType: AgentType | null | undefined,
  launchAgent: AgentType | null | undefined
): AgentType | null | undefined {
  if (entryAgentType && entryAgentType !== 'unknown') {
    return entryAgentType
  }
  return launchAgent ?? entryAgentType
}
