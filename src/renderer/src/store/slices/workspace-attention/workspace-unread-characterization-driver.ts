import type { Worktree } from '../../../../../shared/worktree/types'
import { applyAgentAttention, resolveAgentAttention } from '@/attention/agent-attention-policy'
import { createTerminalAttentionSurface } from '@/components/terminal-pane/terminal-attention-surface'
import { acknowledgeViewedAutoAckTarget } from '@/hooks/agent-auto-ack-surfaces'
import {
  screenOf,
  type AttentionStore,
  type PaneTarget
} from './workspace-unread-characterization-fixture'

// Replay production events here so call-site rewiring changes only the driver, preserving scenario expectations.

/** pane-pty-visibility-bind.ts onBell and parked-terminal-byte-watcher.ts onBell. */
export function ringBell(store: AttentionStore, target: PaneTarget): void {
  store.getState().markTerminalBell(target)
}

/** use-notification-dispatch.ts agent-task-complete path; `paneKey: null` is a workspace-only completion. */
export function completeAgentTurn(
  store: AttentionStore,
  target: { worktreeId: string; paneKey: string | null }
): void {
  const state = store.getState()
  const decision = resolveAgentAttention(
    {
      subject: { workspaceId: target.worktreeId, surfaceKey: target.paneKey ?? undefined },
      reason: 'agent-completion',
      settlesTurn: true,
      hasFreshActivityEvidence: true
    },
    createTerminalAttentionSurface(state)
  )
  applyAgentAttention(decision, {
    unread: state.markAgentAttentionUnread,
    requestDelivery: () => {}
  })
}

/** A keydown in a pane: the window's capture-phase keydown, only a presence signal. */
export function typeInPane(store: AttentionStore, _target: PaneTarget): void {
  screenOf(store).input()
}

/** A pointerdown anywhere in the window: the scan's trusted-input presence signal. */
export function pointerDownInTab(
  store: AttentionStore,
  _target: { worktreeId: string; tabId: string; paneKey: string | null }
): void {
  screenOf(store).input()
}

/** Orca's window gains or loses visibility+focus. */
export function setWindowOnScreen(store: AttentionStore, onScreen: boolean): void {
  screenOf(store).setWindowOnScreen(onScreen)
}

/** Sidebar quick action and context menu "Mark as read/unread". */
export function toggleUnreadByUser(
  store: AttentionStore,
  row: Pick<Worktree, 'id' | 'hostId' | 'isUnread'>
): void {
  store.getState().setWorkspaceUnreadByUser(row.id, !row.isUnread, row.hostId ?? 'local')
}

/** on-screen-attention-scan: the viewed terminal tab's agent is acknowledged (markers are the scan's). */
export function autoAckViewedTab(store: AttentionStore, target: PaneTarget): void {
  acknowledgeViewedAutoAckTarget(store.getState(), {
    tabId: target.tabId,
    worktreeId: target.worktreeId,
    surfaceKind: 'terminal'
  })
}
