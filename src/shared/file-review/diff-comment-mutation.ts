import type { DiffComment } from './diff-comment-types'

export type DiffCommentDeliverySnapshot = Pick<
  DiffComment,
  'body' | 'filePath' | 'id' | 'lineNumber' | 'selectedText' | 'source' | 'startLine' | 'updatedAt'
>

/** Mutation-only snapshot; never persisted with workspace metadata. */
export type DiffCommentBaseMutation = {
  diffCommentsBase?: DiffComment[]
  deliveredDiffCommentSnapshots?: readonly DiffCommentDeliverySnapshot[]
}

export function matchesDeliveredDiffComment(
  comment: DiffComment,
  snapshot: DiffCommentDeliverySnapshot
): boolean {
  return (
    comment.id === snapshot.id &&
    comment.body === snapshot.body &&
    comment.filePath === snapshot.filePath &&
    comment.lineNumber === snapshot.lineNumber &&
    comment.startLine === snapshot.startLine &&
    comment.selectedText === snapshot.selectedText &&
    comment.source === snapshot.source &&
    comment.updatedAt === snapshot.updatedAt
  )
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
  {
    diffComments,
    diffCommentsBase,
    deliveredDiffCommentSnapshots
  }: { diffComments?: DiffComment[] } & DiffCommentBaseMutation
): DiffComment[] | undefined {
  const merged = diffComments
    ? diffCommentsBase
      ? mergeDiffCommentMutation(diffCommentsBase, current ?? [], diffComments)
      : diffComments
    : undefined
  if (deliveredDiffCommentSnapshots) {
    const expected = new Map(deliveredDiffCommentSnapshots.map((note) => [note.id, note]))
    return (merged ?? current)?.filter((note) => {
      const snapshot = expected.get(note.id)
      return !snapshot || !matchesDeliveredDiffComment(note, snapshot)
    })
  }
  return merged
}
