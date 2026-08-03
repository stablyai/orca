import type { NativeChatMessage } from '../../../../shared/native-chat-types'

// Keep object identity stable across streaming frames for rows that did not
// change.
//
// Why this is needed: the projection pipeline mints a fresh array every frame
// (sessionWithPending rebuilds session.messages), and foldToolMessages clones
// any assistant turn that absorbed tool calls as `{...previous, blocks: [...]}`.
// Both are correct, but they hand React a new object for a row whose content is
// identical — so React.memo on the row and the per-row splitNativeChatBlocks memo
// both miss, for nearly every assistant turn. Reconciling against the previous
// frame restores the identity those memos key on.

function sameBlocks(a: NativeChatMessage, b: NativeChatMessage): boolean {
  if (a.blocks === b.blocks) {
    return true
  }
  if (a.blocks.length !== b.blocks.length) {
    return false
  }
  // Blocks themselves are never mutated in place — a changed block is a new
  // object — so reference equality per element is a sound content check.
  return a.blocks.every((block, index) => block === b.blocks[index])
}

function sameRow(a: NativeChatMessage, b: NativeChatMessage): boolean {
  return a.id === b.id && a.role === b.role && sameBlocks(a, b)
}

/**
 * Return `next`, with each row replaced by the corresponding row from
 * `previous` when the two are equivalent. Returns `previous` itself when every
 * row matched and the lengths agree, so an unchanged frame produces no new
 * array either.
 */
export function reconcileNativeChatRowIdentity(
  next: NativeChatMessage[],
  previous: NativeChatMessage[] | null
): NativeChatMessage[] {
  if (!previous) {
    return next
  }
  // Rows are appended and folded at the tail, so index alignment holds for the
  // stable prefix; a shifted window simply misses and re-renders once.
  let changed = next.length !== previous.length
  const reconciled = next.map((row, index) => {
    const prior = previous[index]
    if (prior && sameRow(row, prior)) {
      return prior
    }
    changed = true
    return row
  })
  return changed ? reconciled : previous
}
