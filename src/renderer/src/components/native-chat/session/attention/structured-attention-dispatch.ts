/** Use host journal facts instead of PTY inference, sharing neutral unread/delivery policy; unknown outcomes and already-read prompts stay quiet. */
import {
  notificationExecutionHostForOwner,
  notificationWorkspaceExecutionHostForOwner,
  notificationSourceForOwner
} from '../../../../../../shared/notifications/notification-source'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { resolveNotificationTabOwner } from '@/attention/notification-subject-owner'
import type {
  AgentSessionPromptAttention,
  AgentSessionTurnCompletion
} from '../../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import {
  agentSessionAttentionKey,
  agentSessionAttentionNews,
  attentionOriginWasRead,
  structuredAttentionOrigin,
  type AgentSessionAttentionEdge,
  type StructuredAttentionRead
} from '../../../../../../shared/agent-session/view/agent-session-attention'
import { applyAgentAttention, resolveAgentAttention } from '@/attention/agent-attention-policy'
import {
  deliverAgentAttentionNotification,
  readAgentAttentionNotificationSound
} from '@/attention/agent-attention-notification-delivery'
import { useAppStore } from '@/store'
import { noteWorktreeAgentActivity } from '@/store/slices/worktrees/session/worktree-agent-activity'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { readBots } from '@/lib/bot-catalog'
import { readBotGroups } from '@/lib/bot-group-catalog-snapshot'
import {
  botGroupRoomMembers,
  findBotGroupRoomOfSession,
  isBotGroupMemberSession
} from '../../../../../../shared/bots/bot-group'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../../../../../shared/workspace/identity/workspace-scope'
import { isBotAttentionSilenced } from '../../../../../../shared/bot-notifications'
import { isWorktreeNotificationDeliveryMuted } from '@/attention/worktree-notification-mute'
import { canonicalOrchestrationForRow } from '@/runtime/agent-orchestration/visible-agent-orchestration'
import { isCoordinatorOnlyChatNews } from '../../../../../../shared/orchestration/workers/dispatched-worker-attention'
import { getNotificationWorkspaceLabels } from '@/attention/notification-workspace-labels'
import { createStructuredAttentionSurface } from './structured-attention-surface'
import type { StructuredTab } from '../status/structured-agent-session-tabs'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

export function dispatchStructuredTurnCompletionAttention(
  tab: StructuredTab,
  completion: AgentSessionTurnCompletion,
  subscriptionTarget?: RuntimeClientTarget
): void {
  dispatchStructuredAttention(tab, { type: 'completion', completion }, subscriptionTarget)
}

export function dispatchStructuredPromptAttention(
  tab: StructuredTab,
  prompt: AgentSessionPromptAttention,
  subscriptionTarget?: RuntimeClientTarget,
  readFrontier?: () => StructuredAttentionRead | undefined
): void {
  dispatchStructuredAttention(tab, { type: 'prompt', prompt }, subscriptionTarget, readFrontier)
}

function dispatchStructuredAttention(
  tab: StructuredTab,
  edge: AgentSessionAttentionEdge,
  subscriptionTarget: RuntimeClientTarget | undefined,
  readFrontier?: () => StructuredAttentionRead | undefined
): void {
  // Host outcomes outrank stale row state; absent outcomes from older hosts remain unknown and quiet.
  const news = agentSessionAttentionNews(edge)
  if (!news) {
    return
  }
  const sessionId = edge.type === 'prompt' ? edge.prompt.sessionId : edge.completion.sessionId
  // Recheck session ownership where the pane key is minted so old news cannot mark a rebound tab.
  if (sessionId !== tab.entityId) {
    return
  }
  const origin = structuredAttentionOrigin(edge)
  const promptWasRead = (): boolean => {
    const read = readFrontier?.()
    return edge.type === 'prompt' && read !== undefined && attentionOriginWasRead(origin, read)
  }
  if (promptWasRead()) {
    return
  }
  const botHome = botHomeOfSession(sessionId)
  if (isBotAttentionSilenced(readBots(), botHome ?? tab.worktreeId, news)) {
    return
  }
  const attentionKey = agentSessionAttentionKey(edge)
  const state = useAppStore.getState()
  const paneKey = chatPaneKey(tab.entityId)
  const decision = resolveAgentAttention(
    {
      // Address the renderer tab’s workspace; host scope ids may name different remote workspaces.
      subject: { workspaceId: tab.worktreeId, surfaceKey: paneKey },
      reason: 'agent-completion',
      // A prompt earns unread like a settled turn, as the hook lane's blocked row does.
      settlesTurn: true,
      // Host journal edges prove fresh activity even without a rendered transcript; still require current tab ownership.
      hasFreshActivityEvidence: true,
      coordinatorOnlyNews: isCoordinatorOnlyChatNews(edge, news.agentState, () =>
        canonicalOrchestrationForRow(state, paneKey)
      )
    },
    createStructuredAttentionSurface(state)
  )
  if (!decision.admitted) {
    // A worker's finish raises no unread and a chat has no PTY, so stamp Recent here (#50660).
    // A remote or environment-owned worker is left to its owning host, as the PTY path skips remote mirrors.
    if (decision.cause === 'coordinator-only-news' && subscriptionTarget?.kind === 'local') {
      noteWorktreeAgentActivity(state, tab.worktreeId)
    }
    return
  }
  const row = state.agentStatusByPaneKey.get(paneKey)
  const sound = readAgentAttentionNotificationSound(state.settings ?? {})
  applyAgentAttention(decision, {
    unread: state.markAgentAttentionUnread,
    requestDelivery: (request) => {
      // Unread writes can synchronously cause a genuine read before delivery.
      if (promptWasRead()) {
        return
      }
      // Per-worktree mute keeps the unread writes above but drops the interruption.
      const deliveryState = useAppStore.getState()
      if (
        isWorktreeNotificationDeliveryMuted(deliveryState, request.workspaceId) ||
        (botHome !== null && isWorktreeNotificationDeliveryMuted(deliveryState, botHome))
      ) {
        return
      }
      // The receiving subscription identifies the paired source even when tab ownership is ambiguous.
      const owner =
        subscriptionTarget?.kind === 'environment'
          ? { executionHostId: null, runtimeEnvironmentId: subscriptionTarget.environmentId }
          : resolveNotificationTabOwner(state, tab)
      const executionHost = notificationExecutionHostForOwner(owner)
      deliverAgentAttentionNotification(
        {
          source: 'agent-task-complete',
          surface: 'agent-session',
          // Shared phone/desktop ids let subject-based acknowledgment retire both notifications.
          notificationId: attentionKey,
          attentionKey,
          structuredOrigin: origin,
          // A local session's host is this app's own main, which already pushed its phones.
          ...(subscriptionTarget?.kind === 'local' ? { mobileDeliveredByHost: true } : {}),
          worktreeId: request.workspaceId,
          workspaceExecutionHostId: notificationWorkspaceExecutionHostForOwner(owner),
          ...(executionHost ? { executionHost } : {}),
          paneKey: request.subjectKey ?? undefined,
          ...getNotificationWorkspaceLabels(state, request.workspaceId, tab.label),
          notificationSourceId: notificationSourceForOwner(owner, state),
          terminalTitle: tab.label,
          isActiveWorktree: request.workspaceIsActive,
          ...(row?.agentType ? { agentType: row.agentType } : {}),
          agentState: news.agentState,
          ...(news.outcome ? { agentTurnOutcome: news.outcome } : {}),
          ...(edge.type === 'completion' && edge.completion.failure
            ? { agentFailure: edge.completion.failure }
            : {}),
          ...(row?.prompt ? { agentPrompt: row.prompt } : {}),
          ...(row?.lastAssistantMessage
            ? { agentLastAssistantMessage: row.lastAssistantMessage }
            : {}),
          ...(isSlackThreadSession(state, tab.worktreeId, sessionId)
            ? { agentRepliesInSlack: true as const }
            : {})
        },
        sound
      )
    }
  })
}

/** Whether the session answers a Slack thread, per the links its folder workspace keeps. */
function isSlackThreadSession(
  state: ReturnType<typeof useAppStore.getState>,
  workspaceId: string,
  sessionId: string
): boolean {
  const scope = parseWorkspaceKey(workspaceId)
  const folderId = scope?.type === 'folder' ? scope.folderWorkspaceId : null
  return (
    folderId !== null &&
    (selectFolderWorkspaces(state) ?? []).some(
      (workspace) =>
        workspace.id === folderId &&
        workspace.externalConversations?.some(
          (link) => link.sessionId === sessionId && link.source === 'slack'
        )
    )
  )
}

/** A group member's news is still its bot's: that bot's switches silence it, though it reads in the room. */
function botHomeOfSession(sessionId: string): string | null {
  const room = isBotGroupMemberSession(sessionId)
    ? findBotGroupRoomOfSession(readBotGroups(), sessionId)
    : null
  const botId = room
    ? botGroupRoomMembers(room.group)
        .flat()
        .find((member) => member.sessionId === sessionId)?.botId
    : undefined
  const bot = botId ? readBots().find((candidate) => candidate.id === botId) : undefined
  return bot ? folderWorkspaceKey(bot.folderWorkspaceId) : null
}
