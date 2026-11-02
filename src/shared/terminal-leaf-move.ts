import { makePaneKey, type PaneKey } from './stable-pane-id'

/** Detach one pane into a new tab; the leaf id and its terminal move with it. */
export type TerminalLeafMoveRequest = {
  worktreeId: string
  sourceTabId: string
  targetTabId: string
  leafId: string
  /** The PTY the renderer's pane is attached to now, when it has one. */
  ptyId: string | null
  /** The caller cannot retire an emptied source tab, so the move must leave the source a pane. */
  keepsSourcePane?: true
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
      reason:
        | 'invalid_request'
        | 'target_tab_exists'
        | 'pty_mismatch'
        | 'leaf_in_other_tab'
        | 'last_pane'
    }

export function terminalLeafMovePaneKeys(request: TerminalLeafMoveRequest): {
  from: PaneKey
  to: PaneKey
} {
  return {
    from: makePaneKey(request.sourceTabId, request.leafId),
    to: makePaneKey(request.targetTabId, request.leafId)
  }
}

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
    !(candidate.keepsSourcePane === undefined || candidate.keepsSourcePane === true) ||
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
