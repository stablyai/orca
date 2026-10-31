import type { EditorBufferRecord } from './editor-buffer-record'

/** One side of a join: a record and the draft its views hold. */
export type EditorBufferJoinSide = { record: EditorBufferRecord; draft: string | undefined }

/** No target: rekey. Clean joiner: attach. Dirty joiner/clean target: adopt. Matching dirty draft/baseline/pause: merge; divergent dirty state: detach with own model. */
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
  // Compare all conflict/pause state; undefined pending draft is unknown text, never equal text.
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

/** Detached partners rejoin only when one side is clean; two dirty sides remain separate even with equal text. */
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
