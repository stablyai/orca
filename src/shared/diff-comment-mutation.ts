import type { DiffComment } from './diff-comment-types'

/** Sender-visible list before a mutation; never stored with workspace metadata. */
export type DiffCommentMutation = {
  diffCommentsBase?: readonly DiffComment[]
}

function sameComment(left: DiffComment | undefined, right: DiffComment | undefined): boolean {
  const fields = (comment: DiffComment | undefined) =>
    comment &&
    Object.entries({ ...comment, source: comment.source ?? 'diff' })
      .filter(([, value]) => value !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  return JSON.stringify(fields(left)) === JSON.stringify(fields(right))
}

function commentMap(comments: readonly DiffComment[]): Map<string, DiffComment> {
  const result = new Map(comments.map((comment) => [comment.id, comment]))
  if (result.size !== comments.length) {
    throw new Error('Review note ids must be unique.')
  }
  return result
}

export function mergeDiffCommentMutation(
  base: readonly DiffComment[],
  current: readonly DiffComment[],
  requested: readonly DiffComment[]
): DiffComment[] {
  const baseById = commentMap(base)
  const currentById = commentMap(current)
  const requestedById = commentMap(requested)
  const changedIds = new Set(
    [...baseById.keys(), ...requestedById.keys()].filter(
      (id) => !sameComment(baseById.get(id), requestedById.get(id))
    )
  )
  for (const id of changedIds) {
    const original = baseById.get(id)
    const latest = currentById.get(id)
    const next = requestedById.get(id)
    if (!sameComment(latest, original) && !sameComment(latest, next)) {
      throw new Error('Review notes changed on another device. Reload and try again.')
    }
  }
  return [
    ...current.flatMap((comment) => {
      if (!changedIds.has(comment.id)) {
        return [comment]
      }
      const next = requestedById.get(comment.id)
      return next ? [next] : []
    }),
    ...requested.filter((comment) => changedIds.has(comment.id) && !currentById.has(comment.id))
  ]
}

export function normalizeDiffCommentUpdate<
  T extends { diffComments?: DiffComment[] } & DiffCommentMutation
>(current: readonly DiffComment[] | undefined, mutation: T): Omit<T, 'diffCommentsBase'> {
  const { diffCommentsBase, ...updates } = mutation
  return diffCommentsBase !== undefined && updates.diffComments !== undefined
    ? {
        ...updates,
        diffComments: mergeDiffCommentMutation(
          diffCommentsBase,
          current ?? [],
          updates.diffComments
        )
      }
    : updates
}
