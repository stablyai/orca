import type { EditorBufferRecord } from './editor-buffer-record'

/** One side of a join: a record and the draft its views hold. */
export type EditorBufferJoinSide = { record: EditorBufferRecord; draft: string | undefined }

/**
 * How a view joins the record that already holds its file identity.
 * - `rekey`: no record holds it yet, so the view's record takes the key.
 * - `attach`: the target stands (both clean, or only the target dirty).
 * - `adopt`: only the joining side is dirty, so its draft, baseline and conflict state win.
 * - `merge`: both dirty with the same draft, baseline and pause state.
 * - `detach`: divergent dirty drafts; the joining view keeps its own record and model.
 */
export type EditorBufferJoin = 'rekey' | 'attach' | 'adopt' | 'merge' | 'detach'

export type EditorBufferJoinOnto = Exclude<EditorBufferJoin, 'rekey'>

// Why the draft counts: a clean-flagged tab can still hold a real unsaved draft (Markdown whitespace).
export function isDirtyEditorBufferSide(side: EditorBufferJoinSide): boolean {
  return side.record.isDirty || side.draft !== undefined
}

function joinOnto(
  target: EditorBufferJoinSide,
  joining: EditorBufferJoinSide
): EditorBufferJoinOnto {
  if (!isDirtyEditorBufferSide(joining)) {
    return 'attach'
  }
  if (!isDirtyEditorBufferSide(target)) {
    return 'adopt'
  }
  // Why every field: a merge must not drop either side's conflict or owner-migration pause, and an
  // undefined draft (a rich view's edit still pending) is unknown text, not equal text.
  const identical =
    joining.draft !== undefined &&
    target.draft === joining.draft &&
    target.record.lastKnownDiskSignature === joining.record.lastKnownDiskSignature &&
    target.record.externalMutation === joining.record.externalMutation &&
    target.record.pendingOwnerMigration === joining.record.pendingOwnerMigration
  return identical ? 'merge' : 'detach'
}

export function decideEditorBufferJoin(
  target: EditorBufferJoinSide | null,
  joining: EditorBufferJoinSide
): EditorBufferJoin {
  return target ? joinOnto(target, joining) : 'rekey'
}

/**
 * Whether a detached record and its partner join again: only once one side is clean, which then
 * joins as a clean view. Two dirty sides never merge, even with identical text.
 */
export function decideEditorBufferRejoin(
  detached: EditorBufferJoinSide,
  partner: EditorBufferJoinSide
): EditorBufferJoinOnto | null {
  return isDirtyEditorBufferSide(detached) && isDirtyEditorBufferSide(partner)
    ? null
    : joinOnto(partner, detached)
}

/** The record and draft the joined record holds; null when the sides stay apart. */
export function joinedEditorBuffer(
  target: EditorBufferJoinSide,
  joining: EditorBufferJoinSide,
  join: EditorBufferJoinOnto
): EditorBufferJoinSide | null {
  switch (join) {
    case 'adopt':
      return joining
    case 'attach':
    case 'merge':
      return target
    case 'detach':
      return null
  }
}
