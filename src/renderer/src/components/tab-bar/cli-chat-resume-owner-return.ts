import { conversationSwitchFailureText } from '@/lib/conversation-switch-feedback'
import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  activateAiVaultStructuredSession,
  activateAiVaultStructuredSessionVerified
} from '@/lib/activate-ai-vault-structured-session'
import {
  callStructuredAgentSession,
  supportsInPlaceSwitch
} from '@/runtime/structured-agent-session-client'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { CliChatResumeSource } from './cli-chat-resume-source'

export async function switchIntoOwnerLegacy(
  source: Pick<AiVaultSession, 'agent'> & Pick<CliChatResumeSource, 'tabId' | 'workspaceId'>,
  structuredSession: NonNullable<AiVaultSession['structuredSession']>,
  target: RuntimeClientTarget,
  reportFailure?: (error: unknown) => void
): Promise<boolean> {
  // A host without the switch keeps the earlier behaviour: the chat is shown, the terminal stays.
  if (!(await supportsInPlaceSwitch(target, source.agent))) {
    await activateAiVaultStructuredSession(
      { structuredSession },
      undefined,
      target,
      ...(reportFailure ? ([() => reportFailure(undefined)] as const) : ([] as const))
    )
    return false
  }
  if (!(await startCliChatReturn(source, structuredSession.sessionId, target, reportFailure))) {
    return false
  }
  const shown = await activateAiVaultStructuredSessionVerified(
    { structuredSession },
    undefined,
    target,
    ...(reportFailure ? ([() => reportFailure(undefined)] as const) : ([] as const))
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
  source: Pick<AiVaultSession, 'agent'>,
  sessionId: string,
  target: RuntimeClientTarget,
  reportFailure?: (error: unknown) => void
): Promise<boolean> {
  const switched = await callStructuredAgentSession<
    { ok: true } | { ok: false; refusal: AgentSessionWireRefusal }
  >(target, 'agentSession.switchToChat', { sessionId }).catch(() => null)
  if (!switched?.ok) {
    if (reportFailure) {
      reportFailure(switched ? Object.assign(new Error('Chat switch refused'), switched) : null)
      return false
    }
    toast.error(
      conversationSwitchFailureText(
        switched ? Object.assign(new Error('Chat switch refused'), switched) : null,
        {
          agent: source.agent,
          direction: 'chat'
        }
      )
    )
    return false
  }
  return true
}
