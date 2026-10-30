/** Use host journal facts instead of PTY inference, sharing neutral unread/delivery policy; unknown outcomes and already-read prompts stay quiet. */
import {
  notificationExecutionHostForOwner,
  notificationSourceForOwner
} from '../../../../shared/notification-source'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { resolveNotificationTabOwner } from '@/attention/notification-subject-owner'
import type {
  AgentSessionPromptAttention,
  AgentSessionTurnCompletion
} from '../../../../shared/agent-session-wire'
import {
  agentSessionAttentionKey,
  agentSessionAttentionNews,
  attentionOriginWasRead,
  structuredAttentionOrigin,
  type AgentSessionAttentionEdge,
  type StructuredAttentionRead
} from '../../../../shared/agent-session-attention'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { applyAgentAttention, resolveAgentAttention } from '@/attention/agent-attention-policy'
import {
  deliverAgentAttentionNotification,
  readAgentAttentionNotificationSound
} from '@/attention/agent-attention-notification-delivery'
import { useAppStore } from '@/store'
import { getNotificationWorkspaceLabels } from '../terminal-pane/terminal-notification-state'
import { createStructuredAttentionSurface } from './structured-attention-surface'
import type { StructuredTab } from './structured-agent-session-tabs'

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
  const attentionKey = agentSessionAttentionKey(edge)
  const state = useAppStore.getState()
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const decision = resolveAgentAttention(
    {
      // Address the renderer tab’s workspace; host scope ids may name different remote workspaces.
      subject: { workspaceId: tab.worktreeId, surfaceKey: paneKey },
      reason: 'agent-completion',
      // A prompt earns unread like a settled turn, as the hook lane's blocked row does.
      settlesTurn: true,
      // Host journal edges prove fresh activity even without a rendered transcript; still require current tab ownership.
      hasFreshActivityEvidence: true
    },
    createStructuredAttentionSurface(state)
  )
  if (!decision.admitted) {
    return
  }
  const row = state.agentStatusByPaneKey[paneKey]
  const sound = readAgentAttentionNotificationSound(state.settings ?? {})
  applyAgentAttention(decision, {
    unread: state.markAgentAttentionUnread,
    requestDelivery: (request) => {
      // Unread writes can synchronously cause a genuine read before delivery.
      if (promptWasRead()) {
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
          ...(executionHost ? { executionHost } : {}),
          paneKey: request.subjectKey ?? undefined,
          ...getNotificationWorkspaceLabels(state, request.workspaceId, tab.label),
          notificationSourceId: notificationSourceForOwner(owner, state),
          terminalTitle: tab.label,
          isActiveWorktree: request.workspaceIsActive,
          ...(row?.agentType ? { agentType: row.agentType } : {}),
          agentState: news.agentState,
          ...(news.outcome ? { agentTurnOutcome: news.outcome } : {}),
          ...(row?.prompt ? { agentPrompt: row.prompt } : {}),
          ...(row?.lastAssistantMessage
            ? { agentLastAssistantMessage: row.lastAssistantMessage }
            : {})
        },
        sound
      )
    }
  })
}
