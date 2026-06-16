import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { playDesktopNotificationSound } from '@/lib/desktop-notification-sound'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import { isSupersededAgentCompletionSnapshot } from './agent-completion-snapshot-staleness'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import {
  countReposNeedingNotificationDisambiguation,
  getPaneKeyTabId,
  hasLivePtyForNotification,
  isCurrentKnownPaneKey,
  isCurrentLivePaneKey
} from './terminal-notification-state'
import {
  isOrcaWindowForegroundFocused,
  isVisibleForegroundPaneKey
} from './terminal-notification-pane-visibility'

const AGENT_NOTIFICATION_SNAPSHOT_MAX_AGE_MS = 10_000

export type TerminalNotificationEvent = {
  source: 'terminal-bell' | 'agent-task-complete'
  terminalTitle?: string
  paneKey?: string
  agentStatusSnapshot?: AgentCompletionStatusSnapshot
  suppressOsNotification?: boolean
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
  const storedAgentStatus =
    event.source === 'agent-task-complete' && event.paneKey
      ? state.agentStatusByPaneKey[event.paneKey]
      : undefined
  const freshStoredAgentStatus =
    storedAgentStatus &&
    Date.now() - storedAgentStatus.updatedAt <= AGENT_NOTIFICATION_SNAPSHOT_MAX_AGE_MS
      ? storedAgentStatus
      : undefined
  const agentStatus =
    event.source === 'agent-task-complete'
      ? (event.agentStatusSnapshot ?? freshStoredAgentStatus)
      : undefined
  if (
    event.source === 'agent-task-complete' &&
    isSupersededAgentCompletionSnapshot(storedAgentStatus, event.agentStatusSnapshot)
  ) {
    return
  }
  const agentNotificationStateStartedAt =
    freshStoredAgentStatus?.stateStartedAt ?? event.agentStatusSnapshot?.stateStartedAt
  // Why: main-process hook IPC can update inactive/unmounted worktrees before
  // the renderer's live-PTY map catches up. A fresh accepted hook snapshot is
  // authoritative for agent completion; title/BEL-only paths still need PTY liveness.
  const hasFreshAgentStatus = Boolean(agentStatus)

  // Why: shutdownWorktreeTerminals clears ptyIdsByTabId synchronously
  // before killing PTYs asynchronously. Any notification arriving after
  // that point is stale — e.g. a staleTitleTimer that fires 3 s after
  // shutdown, or an agent tracker transition from accumulated closure
  // state. Checking for live PTYs at dispatch time catches ALL phantom
  // notification sources regardless of which timer or callback produced
  // them, rather than trying to cancel each one individually.
  const hasLivePty = hasLivePtyForNotification(state, worktreeId, event.paneKey)
  if (!hasLivePty && !hasFreshAgentStatus) {
    return
  }

  if (event.source === 'agent-task-complete') {
    const terminalAttentionEnabled = state.settings?.experimentalTerminalAttention === true
    let tabId: string | null = null
    if (event.paneKey) {
      tabId = getPaneKeyTabId(event.paneKey)
      // Why: delayed completion hooks from a closed split pane can arrive while
      // another pane in the tab is still live; stale leaf completions must not
      // create unread state or OS notifications.
      const isCurrentPane = hasLivePty
        ? isCurrentLivePaneKey(state, worktreeId, event.paneKey)
        : isCurrentKnownPaneKey(state, worktreeId, event.paneKey)
      if (!tabId || !isCurrentPane) {
        return
      }
    }

    // Why: a focused worktree can still hide other terminal tabs/split panes;
    // only the exact active pane counts as already viewed.
    const shouldMarkUnread = event.paneKey
      ? !isVisibleForegroundPaneKey(state, worktreeId, event.paneKey)
      : state.activeWorktreeId !== worktreeId || !isOrcaWindowForegroundFocused()
    if (shouldMarkUnread) {
      // Why: activeWorktreeId is only in-app selection. If Orca is backgrounded,
      // a selected chat finishing still needs unread/Dock attention.
      state.markWorktreeUnread(worktreeId)
      if (event.paneKey) {
        // Why: focus-return auto-ack needs an agent-specific source marker;
        // generic pane unread also covers BEL and must still show until interact.
        state.markAgentCompletionPaneUnread(event.paneKey)
      }
      if (terminalAttentionEnabled && tabId && event.paneKey) {
        state.markTerminalTabUnread(tabId)
        state.markTerminalPaneUnread(event.paneKey)
      }
    }
  }

  if (event.suppressOsNotification) {
    return
  }

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

  void window.api.notifications
    .dispatch({
      source: event.source,
      ...(notificationId ? { notificationId } : {}),
      worktreeId,
      paneKey: event.paneKey,
      repoLabel: repo?.displayName,
      worktreeLabel: worktree?.displayName || worktree?.branch || worktreeId,
      hasMultipleActiveRepos: countReposNeedingNotificationDisambiguation(state) > 1,
      terminalTitle: event.terminalTitle,
      isActiveWorktree: state.activeWorktreeId === worktreeId,
      ...agentSnapshot
    })
    .then((result) => {
      if (result.delivered) {
        void playDesktopNotificationSound(customSoundId, customSoundVolume)
      }
    })
    .catch((err) => {
      console.warn('Failed to dispatch notification:', err)
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
