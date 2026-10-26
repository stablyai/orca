import {
  resolveTerminalNotificationOwner,
  type TerminalNotificationBinding
} from '@/attention/notification-subject-owner'
import {
  notificationExecutionHostForOwner,
  notificationSourceForOwner
} from '../../../../shared/notification-source'
import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'
import { shareCompatibleTitleIdentityGroup } from '../../../../shared/agent-title-owner'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { isSupersededAgentCompletionSnapshot } from './agent-completion-snapshot-staleness'
import { isAutoApprovedAntigravityPermission } from './antigravity-auto-approved-permission'
import type {
  AgentCompletionDispatchMeta,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import type { NotificationDispatchResult } from '../../../../shared/notification-settings-types'
import { getNotificationWorkspaceLabels } from './terminal-notification-state'
import { createTerminalAttentionSurface } from './terminal-attention-surface'
import {
  applyAgentAttention,
  resolveAgentAttention,
  type AgentAttentionDeliveryRequest
} from '@/attention/agent-attention-policy'
import {
  deliverAgentAttentionNotification,
  readAgentAttentionNotificationSound
} from '@/attention/agent-attention-notification-delivery'

const AGENT_NOTIFICATION_SNAPSHOT_MAX_AGE_MS = 10_000

function agentSnapshotMatchesExplicitTitle(
  snapshot: { agentType?: string | null } | undefined,
  explicitTitleAgentType: string | null
): boolean {
  return !snapshot || !explicitTitleAgentType || snapshot.agentType === explicitTitleAgentType
}

function hasFreshActiveHookStatus(
  snapshot: Pick<AgentStatusEntry, 'state' | 'updatedAt' | 'agentType'> | undefined,
  explicitTitleAgentType: string | null
): boolean {
  // Pi titles can wrap a live OMP hook; compatible-group frames do not prove pane reuse.
  const titleNamesDifferentKnownAgent =
    explicitTitleAgentType &&
    snapshot?.agentType &&
    snapshot.agentType !== 'unknown' &&
    !shareCompatibleTitleIdentityGroup(snapshot.agentType, explicitTitleAgentType)
  return Boolean(isFreshNonDoneAgentStatus(snapshot) && !titleNamesDifferentKnownAgent)
}

export type TerminalNotificationEvent = TerminalNotificationBinding & {
  source: 'terminal-bell' | 'agent-task-complete'
  terminalTitle?: string
  agentStatusSnapshot?: AgentCompletionStatusSnapshot
  agentCompletionSource?: AgentCompletionDispatchMeta['source']
  /** Main's answer to the delivery request this event sends (null: no answer). */
  onDispatchResult?: (result: NotificationDispatchResult | null) => void
}

/** Stable dispatcher reads labels at dispatch time to avoid per-pane store subscriptions and fresh allWorktrees arrays. */
export function dispatchTerminalNotification(
  worktreeId: string,
  event: TerminalNotificationEvent
): boolean {
  const state = useAppStore.getState()
  // Explicit completion-title identity rejects other-agent snapshot prompts/timing as pane-reuse residue.
  const explicitTitleAgentType =
    event.source === 'agent-task-complete' && event.terminalTitle
      ? resolveCommittedTitleAgentType(event.terminalTitle)
      : null
  const storedAgentStatus =
    event.source === 'agent-task-complete' && event.paneKey
      ? state.agentStatusByPaneKey[event.paneKey]
      : undefined
  const eventAgentStatusSnapshot =
    event.source === 'agent-task-complete' &&
    agentSnapshotMatchesExplicitTitle(event.agentStatusSnapshot, explicitTitleAgentType)
      ? event.agentStatusSnapshot
      : undefined
  const freshStoredAgentStatus =
    storedAgentStatus &&
    Date.now() - storedAgentStatus.updatedAt <= AGENT_NOTIFICATION_SNAPSHOT_MAX_AGE_MS &&
    agentSnapshotMatchesExplicitTitle(storedAgentStatus, explicitTitleAgentType)
      ? storedAgentStatus
      : undefined
  if (
    event.source === 'agent-task-complete' &&
    event.agentCompletionSource !== 'process-exit' &&
    !eventAgentStatusSnapshot &&
    hasFreshActiveHookStatus(storedAgentStatus, explicitTitleAgentType)
  ) {
    // Confirmed exit proves completion even when a title-only idle signal races behind active hook state.
    return false
  }
  // A dead process may never emit done; stale active hooks cannot label its completion prompt/state.
  const agentStatus =
    event.source === 'agent-task-complete'
      ? (eventAgentStatusSnapshot ??
        (event.agentCompletionSource === 'process-exit' && freshStoredAgentStatus?.state !== 'done'
          ? undefined
          : freshStoredAgentStatus))
      : undefined
  if (
    event.source === 'agent-task-complete' &&
    (isSupersededAgentCompletionSnapshot(storedAgentStatus, eventAgentStatusSnapshot) ||
      isAutoApprovedAntigravityPermission(
        agentStatus,
        event.paneKey ? state.agentLaunchConfigByPaneKey[event.paneKey] : undefined
      ))
  ) {
    return false
  }
  const agentNotificationStateStartedAt =
    eventAgentStatusSnapshot?.stateStartedAt ?? freshStoredAgentStatus?.stateStartedAt
  const attentionDecision = resolveAgentAttention(
    {
      subject: { workspaceId: worktreeId, surfaceKey: event.paneKey },
      reason: event.source === 'agent-task-complete' ? 'agent-completion' : 'terminal-bell',
      settlesTurn: event.source === 'agent-task-complete',
      // Fresh accepted hooks can arrive before inactive-worktree PTY hydration; title/BEL-only completion still requires live surface evidence.
      hasFreshActivityEvidence: Boolean(agentStatus)
    },
    createTerminalAttentionSurface(state)
  )
  if (!attentionDecision.admitted) {
    return false
  }

  // Desktop settings are applied in main after independent mobile delivery.

  const sound = readAgentAttentionNotificationSound(state.settings ?? {})
  // Reused pane keys must not expose a prior turn’s prompt without a fresh current snapshot.
  const agentSnapshot = agentStatus
    ? {
        agentType: agentStatus.agentType,
        agentState: agentStatus.state,
        agentPrompt: agentStatus.prompt,
        agentToolName: agentStatus.toolName,
        agentToolInput: agentStatus.toolInput,
        agentLastAssistantMessage: agentStatus.lastAssistantMessage,
        agentTurnOutcome: agentMainAgentVerdict(agentStatus) ?? undefined
      }
    : {}
  const notificationId =
    event.source === 'agent-task-complete'
      ? buildAgentNotificationId({
          worktreeId,
          paneKey: event.paneKey,
          // Carry hook timing after PTY teardown so OS/unread events share the same dismissible identity.
          stateStartedAt: agentNotificationStateStartedAt
        })
      : null

  let requested = false
  const requestDelivery = (request: AgentAttentionDeliveryRequest): void => {
    requested = true
    const owner = resolveTerminalNotificationOwner(state, worktreeId, event)
    const executionHost = notificationExecutionHostForOwner(owner)
    deliverAgentAttentionNotification(
      {
        source: event.source,
        ...(notificationId ? { notificationId } : {}),
        worktreeId: request.workspaceId,
        ...(executionHost ? { executionHost } : {}),
        paneKey: request.subjectKey ?? undefined,
        ...getNotificationWorkspaceLabels(state, request.workspaceId, event.terminalTitle),
        notificationSourceId: notificationSourceForOwner(owner, state),
        terminalTitle: event.terminalTitle,
        isActiveWorktree: request.workspaceIsActive,
        ...agentSnapshot
      },
      sound,
      event.onDispatchResult
    )
  }

  applyAgentAttention(attentionDecision, {
    unread: state.markAgentAttentionUnread,
    requestDelivery
  })
  return requested
}

export function useNotificationDispatch(
  worktreeId: string
): (event: TerminalNotificationEvent) => void {
  return useCallback(
    (event: TerminalNotificationEvent) => {
      dispatchTerminalNotification(worktreeId, event)
    },
    [worktreeId]
  )
}
