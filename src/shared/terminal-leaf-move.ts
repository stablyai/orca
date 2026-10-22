import { makePaneKey, type PaneKey } from './stable-pane-id'
import type { PaneSide } from './workspace-layout/terminal-pane-tree'

/** Detach one pane into a new tab; the leaf id and its terminal move with it. */
export type TerminalLeafMoveRequest = {
  worktreeId: string
  sourceTabId: string
  targetTabId: string
  leafId: string
  /** The PTY the renderer's pane is attached to now, when it has one. */
  ptyId: string | null
}

export type TerminalLeafMoveResult =
  /** Main moved the leaf and every pane-keyed record into the target tab in one durable write. */
  | {
      status: 'moved'
      ptyId: string | null
      /** The new tab's id when main named it (layout-owner builds); else the request's. */
      tabId?: string
    }
  /** Main's session never held the leaf, so there is nothing to move there. */
  | { status: 'not_held' }
  | {
      status: 'refused'
      reason: 'invalid_request' | 'target_tab_exists' | 'pty_mismatch' | 'leaf_in_other_tab'
    }

/** The moved pane's key before and after; only valid requests reach here. */
export function terminalLeafMovePaneKeys(request: TerminalLeafMoveRequest): {
  from: PaneKey
  to: PaneKey
} {
  return {
    from: makePaneKey(request.sourceTabId, request.leafId),
    to: makePaneKey(request.targetTabId, request.leafId)
  }
}

/** The one validation of a move request: shape, distinct tabs, and ids a pane key can carry. */
export function isTerminalLeafMoveRequest(value: unknown): value is TerminalLeafMoveRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate: Record<string, unknown> = { ...value }
  const isId = (field: unknown): field is string =>
    typeof field === 'string' && field.length > 0 && field.length <= 512
  if (
    !isId(candidate.worktreeId) ||
    !isId(candidate.sourceTabId) ||
    !isId(candidate.targetTabId) ||
    !isId(candidate.leafId) ||
    !(candidate.ptyId === null || isId(candidate.ptyId)) ||
    candidate.sourceTabId === candidate.targetTabId
  ) {
    return false
  }
  try {
    makePaneKey(candidate.sourceTabId, candidate.leafId)
    makePaneKey(candidate.targetTabId, candidate.leafId)
    return true
  } catch {
    return false
  }
}

const PANE_SIDES: readonly PaneSide[] = ['left', 'right', 'top', 'bottom']

/** Join a single-leaf tab into an existing tab: its leaf becomes a split beside `targetLeafId`. */
export type TerminalLeafIntoTabRequest = TerminalLeafMoveRequest & {
  targetLeafId: string
  placement: { kind: 'beside'; side: PaneSide }
}

export type TerminalLeafIntoTabRefusal =
  | 'invalid_request'
  | 'unsupported'
  | 'source_not_single_leaf'
  | 'source_is_chat'
  | 'source_launch_pending'
  | 'target_tab_missing'
  | 'target_leaf_missing'
  | 'target_is_chat'
  | 'partition_mismatch'
  | 'leaf_in_other_tab'
  | 'pty_mismatch'
  | 'pty_missing'
  | 'kill_list_contains_moved_pty'
  | 'workspace_frozen'
  | 'layout_owner_build'

export type TerminalLeafIntoTabResult =
  /** Main grafted the leaf into the target and closed the source tab in one durable write. */
  | { status: 'moved'; ptyId: string; sourceTabClosed: true }
  /** Main's session never held the leaf; the renderer must not apply the move alone. */
  | { status: 'not_held' }
  | { status: 'refused'; reason: TerminalLeafIntoTabRefusal }

export function isTerminalLeafIntoTabRequest(value: unknown): value is TerminalLeafIntoTabRequest {
  if (!isTerminalLeafMoveRequest(value)) {
    return false
  }
  const candidate: Record<string, unknown> = { ...value }
  const { targetLeafId, placement } = candidate
  if (typeof targetLeafId !== 'string' || targetLeafId === candidate.leafId) {
    return false
  }
  if (!placement || typeof placement !== 'object') {
    return false
  }
  const { kind, side }: Record<string, unknown> = { ...placement }
  if (kind !== 'beside' || !PANE_SIDES.some((known) => known === side)) {
    return false
  }
  try {
    makePaneKey(String(candidate.targetTabId), targetLeafId)
    return true
  } catch {
    return false
  }
}
