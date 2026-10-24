import type { AttentionTarget } from './next-attention-queue'

/** Where the user is now; a null field means nothing is active at that level. */
export type AttentionPosition = {
  workspaceIdentity: string | null
  unifiedTabId: string | null
  terminalTabId: string | null
  leafId: string | null
}

function isAt(target: AttentionTarget, current: AttentionPosition): boolean {
  if (target.workspaceIdentity !== current.workspaceIdentity) {
    return false
  }
  if (target.level === 'workspace') {
    return true
  }
  // Why the terminal entity for terminals: a pane is the same place whichever split copy shows it.
  const sameTab =
    target.terminalTabId !== undefined
      ? target.terminalTabId === current.terminalTabId
      : target.unifiedTabId === current.unifiedTabId
  return sameTab && (target.level === 'tab' || target.leafId === current.leafId)
}

/**
 * From a place that needs attention, step to the next one (wrapping); from anywhere else,
 * go to the topmost. Stateless by design: a read target drops out of the queue, so the next
 * press returns to the top rather than continuing below it.
 */
export function pickNextAttentionTarget(
  queue: readonly AttentionTarget[],
  current: AttentionPosition
): AttentionTarget | null {
  if (queue.length === 0) {
    return null
  }
  const index = queue.findIndex((target) => isAt(target, current))
  return index === -1 ? queue[0] : queue[(index + 1) % queue.length]
}
