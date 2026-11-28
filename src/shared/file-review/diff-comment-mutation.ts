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
  comment: DiffCommentDeliverySnapshot,
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

function indexRevisionsById(
  revisions: readonly DiffCommentDeliverySnapshot[]
): Map<string, DiffCommentDeliverySnapshot[]> {
  const byId = new Map<string, DiffCommentDeliverySnapshot[]>()
  for (const revision of revisions) {
    const bucket = byId.get(revision.id)
    if (bucket) {
      bucket.push(revision)
    } else {
      byId.set(revision.id, [revision])
    }
  }
  return byId
}

/** Same answer as `revisions.some(r => matchesDeliveredDiffComment(note, r))`, by id lookup so whole-list scans stay linear. */
export function createDeliveredDiffCommentMatcher(
  revisions: readonly DiffCommentDeliverySnapshot[]
): (note: DiffCommentDeliverySnapshot) => boolean {
  // Built on the first query: callers often pass it to an empty or short-circuiting scan.
  let byId: Map<string, DiffCommentDeliverySnapshot[]> | undefined
  return (note) => {
    byId ??= indexRevisionsById(revisions)
    return (
      byId.get(note.id)?.some((revision) => matchesDeliveredDiffComment(note, revision)) ?? false
    )
  }
}

/** Same answer as `revisions.filter(r => notes.some(n => matchesDeliveredDiffComment(n, r)))`, in one pass over notes. */
export function filterRevisionsStillListed<T extends DiffCommentDeliverySnapshot>(
  revisions: readonly T[],
  notes: readonly DiffCommentDeliverySnapshot[]
): T[] {
  if (revisions.length === 0) {
    return []
  }
  // Why: index the reported side and stop once all are found, so a one-note report doesn't index the whole list.
  const byId = indexRevisionsById(revisions)
  const listed = new Set<DiffCommentDeliverySnapshot>()
  const wanted = new Set(revisions).size
  for (const note of notes) {
    for (const revision of byId.get(note.id) ?? []) {
      if (!listed.has(revision) && matchesDeliveredDiffComment(note, revision)) {
        listed.add(revision)
      }
    }
    if (listed.size === wanted) {
      break
    }
  }
  return revisions.filter((revision) => listed.has(revision))
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
