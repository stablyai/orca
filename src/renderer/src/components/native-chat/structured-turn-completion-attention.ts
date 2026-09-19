/**
 * What a settled structured turn earns: workspace unread, the chat's own attention markers, and a
 * delivery request — decided by the same provider-neutral policy the terminal path uses, asked
 * through the structured surface adapter.
 *
 * There is deliberately no structured-specific suppression, liveness or sibling rule here. Every
 * such question is `AgentAttentionSurface`'s, and `createStructuredAttentionSurface` already
 * answers all of them for a chat tab; this module only supplies the request and the sinks. The
 * sinks are the same four the terminal path writes, so a chat and a terminal in one workspace hold
 * one shared set of markers rather than two that can disagree.
 *
 * ONLY `success` LIGHTS ANYTHING. A failure or a cancellation is a real event the host reports,
 * and it earns no indicator: a dot that says "done!" for an API error or for a stop the user asked
 * for teaches the user to distrust every dot. The transport never emits an unknown verdict at all.
 */
import { useAppStore } from '@/store'
import {
  applyAgentAttention,
  resolveAgentAttention,
  type AgentAttentionDeliveryRequest
} from '@/attention/agent-attention-policy'
import {
  deliverAgentAttentionNotification,
  readAgentAttentionNotificationSound
} from '@/attention/agent-attention-notification-delivery'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import type { StructuredTurnCompletion } from '../../../../shared/structured-turn-completion'
import { structuredTurnCompletionKey } from '../../../../shared/structured-turn-completion'
import { getNotificationWorkspaceLabels } from '../terminal-pane/terminal-notification-state'
import { createStructuredAttentionSurface } from './structured-attention-surface'

export type StructuredTurnCompletionTarget = {
  workspaceId: string
  /** The pane key the structured status producer publishes: `<unifiedTabId>:<sessionLeaf>`. */
  paneKey: string
  /** Tab label, used only as the notification's title fallback. */
  label: string
}

/**
 * Raise attention for one settled root turn.
 *
 * Returns nothing: whether a banner appears is main's decision (enabled/source preferences and
 * suppress-while-focused are applied there, after mobile fan-out), and whether unread was written
 * is the policy's. A caller must not read a return value as "the user was told".
 */
export function dispatchStructuredTurnCompletion(
  completion: StructuredTurnCompletion,
  target: StructuredTurnCompletionTarget
): void {
  if (completion.outcome !== 'success') {
    return
  }
  const state = useAppStore.getState()
  const decision = resolveAgentAttention(
    {
      subject: { workspaceId: target.workspaceId, surfaceKey: target.paneKey },
      reason: 'agent-completion',
      settlesTurn: true,
      // Why: the host derived this from its own journal commit for a session that runs with no
      // renderer PTY, so the event itself is the out-of-band proof the subject just produced
      // work. Admission still has to place the surface — a key naming a closed or rebound tab is
      // rejected there, not here.
      hasFreshActivityEvidence: true,
      // Same gate as the terminal path: the container marker is presentation policy, so a chat
      // tab lights its dot under exactly the setting a terminal tab does.
      groupAttentionEnabled: state.settings?.experimentalTerminalAttention === true
    },
    createStructuredAttentionSurface(state)
  )
  if (!decision.admitted) {
    return
  }

  const sound = readAgentAttentionNotificationSound(state.settings ?? {})
  const row = state.agentStatusByPaneKey?.[target.paneKey]
  // Shares the agent notification id shape with the terminal path so an unread agent event and
  // its OS notification stay dismissible under one id; null when the row has no turn timing yet.
  const notificationId = buildAgentNotificationId({
    worktreeId: target.workspaceId,
    paneKey: target.paneKey,
    stateStartedAt: row?.stateStartedAt
  })
  const requestDelivery = (request: AgentAttentionDeliveryRequest): void => {
    deliverAgentAttentionNotification(
      {
        source: 'agent-task-complete',
        ...(notificationId ? { notificationId } : {}),
        // Why: the host is the only party that can see every connected window, so it owns the
        // one-mobile-push-per-completion decision. Each window still decides its own banner.
        mobileDedupeKey: structuredTurnCompletionKey(completion),
        worktreeId: request.workspaceId,
        paneKey: request.subjectKey ?? undefined,
        ...getNotificationWorkspaceLabels(state, request.workspaceId, target.label),
        terminalTitle: target.label,
        isActiveWorktree: request.workspaceIsActive,
        ...(row
          ? {
              agentType: row.agentType,
              agentState: row.state,
              agentPrompt: row.prompt,
              agentLastAssistantMessage: row.lastAssistantMessage
            }
          : {})
      },
      sound
    )
  }

  applyAgentAttention(decision, {
    unread: {
      markWorkspaceUnread: state.markWorktreeUnread,
      markSubjectUnread: state.markAgentCompletionPaneUnread,
      // The container id is the chat's unified tab id, which is what SortableTab reads this
      // marker back under; `markTerminalTabUnread` accepts both tab indexes for that reason.
      markGroupUnread: state.markTerminalTabUnread,
      markSurfaceUnread: state.markTerminalPaneUnread
    },
    requestDelivery
  })
}
