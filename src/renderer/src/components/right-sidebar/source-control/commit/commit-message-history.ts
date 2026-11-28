/** Newest last; blank messages and back-to-back repeats add no recall stop. */
export const COMMIT_MESSAGE_HISTORY_LIMIT = 50

export type CommitMessageHistoryDirection = 'back' | 'forward'

/** Stable ids would survive a replaced history; the recalled text keeps recall valid past an append. */
export type CommitMessageRecallPosition = { index: number; recalled: string }

export function appendCommitMessageHistory(
  history: readonly string[],
  message: string
): readonly string[] {
  const trimmed = message.trim()
  if (trimmed === '' || history.at(-1) === trimmed) {
    return history
  }
  const next = [...history, trimmed]
  return next.length > COMMIT_MESSAGE_HISTORY_LIMIT
    ? next.slice(next.length - COMMIT_MESSAGE_HISTORY_LIMIT)
    : next
}

export function isCommitMessageRecallActive(
  position: CommitMessageRecallPosition | null,
  draft: string
): position is CommitMessageRecallPosition {
  return position !== null && position.recalled === draft
}

/** A plain collapsed arrow recalls only from the start/end line; anything else keeps normal caret movement. */
export function commitMessageHistoryDirection(input: {
  key: string
  draft: string
  selectionStart: number
  selectionEnd: number
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  /** While browsing, arrows step history wherever the caret sits in a recalled multi-line message. */
  recallActive?: boolean
}): CommitMessageHistoryDirection | null {
  if (input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) {
    return null
  }
  if (input.selectionStart !== input.selectionEnd) {
    return null
  }
  if (input.key === 'ArrowUp') {
    return input.recallActive || input.draft.lastIndexOf('\n', input.selectionStart - 1) === -1
      ? 'back'
      : null
  }
  if (input.key === 'ArrowDown') {
    return input.recallActive || !input.draft.includes('\n', input.selectionEnd) ? 'forward' : null
  }
  return null
}

/** Start Back only from empty input and stop at the oldest; Forward past the newest restores the empty draft. */
export function stepCommitMessageHistory(input: {
  direction: CommitMessageHistoryDirection
  history: readonly string[]
  position: CommitMessageRecallPosition | null
  draft: string
}): { position: CommitMessageRecallPosition | null; draft: string } | null {
  const { direction, history, position, draft } = input
  let active = -1
  if (isCommitMessageRecallActive(position, draft)) {
    active =
      history[position.index] === position.recalled
        ? position.index
        : history.lastIndexOf(position.recalled)
  }
  if (active < 0 && (direction === 'forward' || draft !== '')) {
    return null
  }
  const nextIndex =
    direction === 'forward' ? active + 1 : active < 0 ? history.length - 1 : active - 1
  const next = history[nextIndex]
  if (next !== undefined) {
    return { position: { index: nextIndex, recalled: next }, draft: next }
  }
  return direction === 'forward' ? { position: null, draft: '' } : null
}
