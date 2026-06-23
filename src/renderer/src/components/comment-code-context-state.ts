export type CommentCodeContextLineUpdate = number | ((current: number) => number)
export type CommentCodeContextCommentId = string | number

export type CommentCodeContextExpansionState = {
  commentId: CommentCodeContextCommentId
  contextBefore: number
  contextAfter: number
}

export function createCommentCodeContextExpansionState(
  commentId: CommentCodeContextCommentId
): CommentCodeContextExpansionState {
  return {
    commentId,
    contextBefore: 0,
    contextAfter: 0
  }
}

export function resolveCommentCodeContextExpansionState(
  state: CommentCodeContextExpansionState,
  commentId: CommentCodeContextCommentId
): CommentCodeContextExpansionState {
  return state.commentId === commentId ? state : createCommentCodeContextExpansionState(commentId)
}

function resolveLineUpdate(update: CommentCodeContextLineUpdate, current: number): number {
  return typeof update === 'function' ? update(current) : update
}

export function updateCommentCodeContextExpansionState(
  state: CommentCodeContextExpansionState,
  commentId: CommentCodeContextCommentId,
  updates: {
    contextBefore?: CommentCodeContextLineUpdate
    contextAfter?: CommentCodeContextLineUpdate
  }
): CommentCodeContextExpansionState {
  const resolved = resolveCommentCodeContextExpansionState(state, commentId)
  return {
    ...resolved,
    contextBefore:
      updates.contextBefore === undefined
        ? resolved.contextBefore
        : resolveLineUpdate(updates.contextBefore, resolved.contextBefore),
    contextAfter:
      updates.contextAfter === undefined
        ? resolved.contextAfter
        : resolveLineUpdate(updates.contextAfter, resolved.contextAfter)
  }
}
