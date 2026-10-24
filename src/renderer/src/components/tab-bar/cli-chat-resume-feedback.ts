import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { structuredLaunchFailure } from '@/lib/structured-agent-session-launch-failure'
import {
  activateAiVaultStructuredSession,
  activateAiVaultStructuredSessionVerified
} from '@/lib/activate-ai-vault-structured-session'
import {
  callStructuredAgentSession,
  supportsInPlaceSwitch
} from '@/runtime/structured-agent-session-client'
import { agentSessionWriteFailureText } from '../native-chat/agent-session-write-notice-text'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { cliConversationExitGuidance } from '@/lib/cli-conversation-exit-guidance'
import type { CliChatResumeSource } from './cli-chat-resume-source'

/** True only when the chat already holding the conversation took it over: the host started its
 *  agent (catching up on the terminal's turns) and its tab is active. Otherwise the terminal stays. */
export async function reportCliChatResumeFailure(
  source: CliChatResumeSource,
  error: unknown,
  target: RuntimeClientTarget
): Promise<boolean> {
  const owner = structuredLaunchFailure(error)?.owner
  if (owner) {
    return switchIntoOwner(source, owner, target)
  }
  toastCliChatResumeFailure(source, error)
  return false
}

export async function switchIntoOwner(
  source: Pick<CliChatResumeSource, 'agent' | 'tabId' | 'workspaceId'>,
  structuredSession: NonNullable<AiVaultSession['structuredSession']>,
  target: RuntimeClientTarget
): Promise<boolean> {
  // A host without the switch keeps the earlier behaviour: the chat is shown, the terminal stays.
  if (!(await supportsInPlaceSwitch(target, source.agent))) {
    await activateAiVaultStructuredSession({ structuredSession }, undefined, target)
    return false
  }
  if (!(await startCliChatReturn(source, structuredSession.sessionId, target))) {
    return false
  }
  const shown = await activateAiVaultStructuredSessionVerified(
    { structuredSession },
    undefined,
    target
  )
  if (shown !== 'activated') {
    return false
  }
  if (structuredSession.workspaceId !== source.workspaceId) {
    const state = useAppStore.getState()
    const scope = parseWorkspaceKey(structuredSession.workspaceId)
    const folder =
      scope?.type === 'folder'
        ? selectFolderWorkspaces(state).find(
            (workspace) => workspace.id === scope.folderWorkspaceId
          )
        : undefined
    const worktree = getIndexedWorktreeById(
      selectWorktreesByRepo(state),
      structuredSession.workspaceId
    )
    const workspace =
      folder?.name ??
      (worktree ? resolveWorktreeDisplayName(worktree) : structuredSession.workspaceId)
    toast.success(
      translate('components.tab.bar.switch.openedInWorkspace', 'Opened chat in {{workspace}}.', {
        workspace
      })
    )
    return false
  }
  {
    const state = useAppStore.getState()
    const tabs = state.unifiedTabsByWorktree[source.workspaceId] ?? []
    const chat = tabs.find(
      (tab) => tab.contentType === 'agent-session' && tab.entityId === structuredSession.sessionId
    )
    const group = state.groupsByWorktree[source.workspaceId]?.find((g) =>
      g.tabOrder.includes(source.tabId)
    )
    if (chat && group) {
      const order = group.tabOrder.filter((id) => id !== chat.id)
      const index = order.indexOf(source.tabId) + 1
      if (chat.groupId === group.id) {
        order.splice(index, 0, chat.id)
        state.reorderUnifiedTabs(group.id, order)
      } else {
        state.moveUnifiedTabToGroup(chat.id, group.id, { index, activate: true })
      }
    }
  }
  return shown === 'activated'
}

/** Explicit returns await the selected child; ordinary lazy creation remains unchanged. */
export async function startCliChatReturn(
  source: Pick<CliChatResumeSource, 'agent'>,
  sessionId: string,
  target: RuntimeClientTarget
): Promise<boolean> {
  const switched = await callStructuredAgentSession<
    { ok: true } | { ok: false; refusal: AgentSessionWireRefusal }
  >(target, 'agentSession.switchToChat', { sessionId }).catch(() => null)
  if (!switched?.ok) {
    const failure = switched
      ? structuredLaunchFailure(Object.assign(new Error(switched.refusal.message), switched))
      : undefined
    // Never the owner shortcut again: a refused start keeps the terminal and says why.
    toast.error(
      failure?.code === 'agent_session_operation_invalid' &&
        failure.details?.reason === 'conversationOpenInTerminal'
        ? cliConversationExitGuidance(source.agent, true)
        : agentSessionWriteFailureText(failure ?? { kind: 'unconfirmed' }, 'read-history', {
            agentName: agentLabel(source.agent)
          })
    )
    return false
  }
  return true
}

export function toastCliChatResumeFailure(source: CliChatResumeSource, error: unknown): void {
  const refusal = structuredLaunchFailure(error)
  if (
    refusal?.code === 'agent_session_conflict' ||
    refusal?.code === 'agent_session_ownership_unknown'
  ) {
    toast.error(
      refusal.code === 'agent_session_conflict' &&
        refusal.details?.reason === 'conversationHeldElsewhere'
        ? cliConversationExitGuidance(source.agent, true)
        : translate(
            'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
            'Another chat is already holding this conversation.'
          )
    )
    return
  }
  // The chat's agent refused to start while the terminal may still write the conversation.
  if (
    refusal?.code === 'agent_session_operation_invalid' &&
    refusal.details?.reason === 'conversationOpenInTerminal'
  ) {
    toast.error(cliConversationExitGuidance(source.agent, true))
    return
  }
  if (refusal?.code === 'agent_session_identity_required') {
    if (refusal.details?.reason === 'transcriptNotFound') {
      toast.error(
        translate(
          'components.native-chat.resumeInNewChat.notSavedYet',
          "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
          { agent: agentLabel(source.agent) }
        )
      )
      return
    }
    const failure = structuredLaunchFailure(error)
    if (failure) {
      toast.error(agentSessionWriteFailureText(failure, 'read-history'))
      return
    }
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}
