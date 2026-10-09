/** The execution owner half of a document's identity: an unset or blank runtime means local. */
export function runtimeOwnerKey(runtimeEnvironmentId: string | null | undefined): string | null {
  return runtimeEnvironmentId?.trim() || null
}

/**
 * The fields that decide whether two editor records are the same document. Declared structurally
 * so a live `OpenFile` and a `PersistedOpenFile` — whose `runtimeEnvironmentId` optionality
 * differs — both satisfy it without a cast.
 */
export type EditorDocumentIdentityFields = {
  worktreeId: string
  filePath: string
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string | null
  readOnly?: boolean
  liveTail?: boolean
}

/**
 * Identity of one edit document: one path, one owner. Persisted records carry no id, so two
 * records sharing this key serialize to indistinguishable rows that restore as one document —
 * the write merges them, a close sweeps all of them, and the restore heal collapses them.
 *
 * `owner` defaults to the record's own runtime owner; the restore heal passes the route owner it
 * is normalizing onto so pre- and post-heal owners group together.
 */
export function editorDocumentIdentityKey(
  file: EditorDocumentIdentityFields,
  owner: string | null = runtimeOwnerKey(file.runtimeEnvironmentId)
): string {
  return JSON.stringify([
    file.worktreeId,
    owner,
    file.externalSshTargetId?.trim() || null,
    file.filePath,
    // Why: a read-only log tab and a writable tab on one path are different documents — merging
    // them would restore the log writable, carrying a hot-exit draft it must never have.
    file.readOnly === true,
    // Why gated on readOnly: the writer persists liveTail only for a read-only row, and an
    // identity finer than the row it serializes to leaves a duplicate restore cannot tell apart.
    file.readOnly === true && file.liveTail === true
  ])
}
