import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { playDesktopNotificationSound } from '@/lib/desktop-notification-sound'
import { showBlockedNotificationFallbackToast } from '@/lib/blocked-notification-fallback'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import { shareCompatibleTitleIdentityGroup } from '../../../../shared/agent-title-owner'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { isSupersededAgentCompletionSnapshot } from './agent-completion-snapshot-staleness'
import type {
  AgentCompletionDispatchMeta,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import { countReposNeedingNotificationDisambiguation } from './terminal-notification-state'
import { createTerminalAttentionSurface } from './terminal-attention-surface'
import {
  applyAgentAttention,
  resolveAgentAttention,
  type AgentAttentionDeliveryRequest
} from '@/attention/agent-attention-policy'

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
  // Why: pick-a-winner ownership would treat a Pi idle title as a different
  // agent than a live OMP hook. Same-group titles are wrapper frames, not reuse.
  const titleNamesDifferentKnownAgent =
    explicitTitleAgentType &&
    snapshot?.agentType &&
    snapshot.agentType !== 'unknown' &&
    !shareCompatibleTitleIdentityGroup(snapshot.agentType, explicitTitleAgentType)
  return Boolean(isFreshNonDoneAgentStatus(snapshot) && !titleNamesDifferentKnownAgent)
}

export type TerminalNotificationEvent = {
  source: 'terminal-bell' | 'agent-task-complete'
  terminalTitle?: string
  paneKey?: string
  agentStatusSnapshot?: AgentCompletionStatusSnapshot
  agentCompletionSource?: AgentCompletionDispatchMeta['source']
}

/**
 * Returns a stable dispatch function for terminal notifications.
 * Reads repo/worktree labels from the store at dispatch time rather
 * than via selectors — avoids the allWorktrees() anti-pattern which
 * creates a new array reference on every store update and triggers
 * excessive re-renders of TerminalPane.
 */
export function dispatchTerminalNotification(
  worktreeId: string,
  event: TerminalNotificationEvent
): void {
  const state = useAppStore.getState()
  // Why: the completion title is the live identity. If it explicitly names an
  // agent, any snapshot from another agent is stale pane-reuse residue and must
  // not lend its prompt/agentType or timing id to this notification.
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
    // Why: a title-only idle signal can race behind active hook state; a
    // confirmed process exit is independent authority that the turn ended.
    return
  }
  // Why: a process can die before its hook emits done; do not label the
  // resulting completion notification with that stale active state or prompt.
  const agentStatus =
    event.source === 'agent-task-complete'
      ? (eventAgentStatusSnapshot ??
        (event.agentCompletionSource === 'process-exit' && freshStoredAgentStatus?.state !== 'done'
          ? undefined
          : freshStoredAgentStatus))
      : undefined
  if (
    event.source === 'agent-task-complete' &&
    isSupersededAgentCompletionSnapshot(storedAgentStatus, eventAgentStatusSnapshot)
  ) {
    return
  }
  const agentNotificationStateStartedAt =
    eventAgentStatusSnapshot?.stateStartedAt ?? freshStoredAgentStatus?.stateStartedAt
  const attentionDecision = resolveAgentAttention(
    {
      subject: { workspaceId: worktreeId, surfaceKey: event.paneKey },
      reason: event.source === 'agent-task-complete' ? 'agent-completion' : 'terminal-bell',
      settlesTurn: event.source === 'agent-task-complete',
      // Why: main-process hook IPC can update inactive worktrees before the renderer's live-PTY
      // map catches up. An accepted fresh hook snapshot is authority that the turn ended;
      // title/BEL-only paths still need surface liveness.
      hasFreshActivityEvidence: Boolean(agentStatus),
      groupAttentionEnabled: state.settings?.experimentalTerminalAttention === true
    },
    createTerminalAttentionSurface(state)
  )
  if (!attentionDecision.admitted) {
    return
  }

  // Desktop settings are applied in main after independent mobile delivery.

  // Why: prefer worktree.repoId over string-parsing the worktreeId. The
  // `${repoId}::${path}` format is an implementation detail of id
  // construction; coupling the notification dispatcher to it would silently
  // drop the repo label if that format ever changes. The worktree object
  // itself is the source of truth for its owning repo.
  const worktree = getWorktreeMapFromState(state).get(worktreeId)
  const repo = worktree ? getRepoMapFromState(state).get(worktree.repoId) : null
  const customSoundId = state.settings?.notifications?.customSoundId ?? 'system'
  const customSoundVolume = state.settings?.notifications?.customSoundVolume ?? null
  // Why: pane keys are reused across turns. A rich OS notification must not
  // expose the previous turn's prompt if the current turn has no fresh hook snapshot yet.
  const agentSnapshot = agentStatus
    ? {
        agentType: agentStatus.agentType,
        agentState: agentStatus.state,
        agentPrompt: agentStatus.prompt,
        agentToolName: agentStatus.toolName,
        agentToolInput: agentStatus.toolInput,
        agentLastAssistantMessage: agentStatus.lastAssistantMessage,
        agentInterrupted: agentStatus.interrupted
      }
    : {}
  const notificationId =
    event.source === 'agent-task-complete'
      ? buildAgentNotificationId({
          worktreeId,
          paneKey: event.paneKey,
          // Why: delayed hook completions may dispatch after PTY teardown has
          // removed the live row; carry the hook timing so the OS notification
          // still has the same dismissible id as the unread agent event.
          stateStartedAt: agentNotificationStateStartedAt
        })
      : null

  const requestDelivery = (request: AgentAttentionDeliveryRequest): void => {
    void window.api.notifications
      .dispatch({
        source: event.source,
        ...(notificationId ? { notificationId } : {}),
        worktreeId: request.workspaceId,
        paneKey: request.subjectKey ?? undefined,
        repoLabel: repo?.displayName,
        worktreeLabel: worktree?.displayName || worktree?.branch || worktreeId,
        hasMultipleActiveRepos: countReposNeedingNotificationDisambiguation(state) > 1,
        terminalTitle: event.terminalTitle,
        isActiveWorktree: request.workspaceIsActive,
        ...agentSnapshot
      })
      .then((result) => {
        if (result.delivered) {
          void playDesktopNotificationSound(customSoundId, customSoundVolume)
          return
        }
        // Why: macOS is silently swallowing notifications (permission off or
        // prompt unanswered) — surface an in-app pointer at the fix instead of
        // letting the alert vanish without a trace.
        if (result.reason === 'blocked-by-system') {
          showBlockedNotificationFallbackToast()
        }
      })
      .catch((err) => {
        console.warn('Failed to dispatch notification:', err)
      })
  }

  applyAgentAttention(attentionDecision, {
    unread: {
      markWorkspaceUnread: state.markWorktreeUnread,
      markSubjectUnread: state.markAgentCompletionPaneUnread,
      markGroupUnread: state.markTerminalTabUnread,
      markSurfaceUnread: state.markTerminalPaneUnread
    },
    requestDelivery
  })
}

export function useNotificationDispatch(
  worktreeId: string
): (event: TerminalNotificationEvent) => void {
  return useCallback(
    (event: TerminalNotificationEvent) => dispatchTerminalNotification(worktreeId, event),
    [worktreeId]
  )
}
