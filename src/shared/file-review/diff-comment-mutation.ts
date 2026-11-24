import type { DiffComment } from './diff-comment-types'

/** Mutation-only snapshot; never persisted with workspace metadata. */
export type DiffCommentBaseMutation = {
  diffCommentsBase?: DiffComment[]
}

// Why: a writer's list can predate another device's edits, so apply only what it changed since its base.
export function mergeDiffCommentMutation(
  base: readonly DiffComment[],
  current: readonly DiffComment[],
  requested: readonly DiffComment[]
): DiffComment[] {
  const baseById = new Map(base.map((comment) => [comment.id, comment]))
  const requestedById = new Map(requested.map((comment) => [comment.id, comment]))
  const retained = current.flatMap((comment) => {
    const before = baseById.get(comment.id)
    if (!before) {
      return [comment]
    }
    const after = requestedById.get(comment.id)
    if (!after) {
      return []
    }
    return [JSON.stringify(before) === JSON.stringify(after) ? comment : after]
  })
  const currentIds = new Set(current.map((comment) => comment.id))
  const added = requested.filter(
    (comment) => !baseById.has(comment.id) && !currentIds.has(comment.id)
  )
  return [...retained, ...added]
}

/** The list a write leaves; with a base, only the writer's edit applies, so a stale writer keeps others' notes. */
export function applyDiffCommentWrite(
  current: readonly DiffComment[] | undefined,
  { diffComments, diffCommentsBase }: { diffComments?: DiffComment[] } & DiffCommentBaseMutation
): DiffComment[] | undefined {
  return diffComments && diffCommentsBase
    ? mergeDiffCommentMutation(diffCommentsBase, current ?? [], diffComments)
    : diffComments
}
