import type { PersistedOpenFile } from '../../../../../shared/workspace-session/workspace-session-state-types'

/** Saved drafts of workspaces this window could not restore (folder gone while Orca was closed), by owner key; saves carry them verbatim until recovered. */
export type StrandedEditorDrafts = Record<string, PersistedOpenFile[]>

/** Writable files holding unsaved text; read-only tabs never restore a draft. */
export function strandedDraftFiles(files: readonly PersistedOpenFile[]): PersistedOpenFile[] {
  return files.filter((file) => file.readOnly !== true && file.dirtyDraftContent !== undefined)
}

function sameFileOwner(a: PersistedOpenFile, b: PersistedOpenFile): boolean {
  return (
    a.filePath === b.filePath &&
    (a.runtimeEnvironmentId ?? null) === (b.runtimeEnvironmentId ?? null)
  )
}

/** A live tab's own draft wins; a clean live tab yields to the stranded draft the user never saw. */
export function withStrandedEditorDrafts(
  byWorktree: Record<string, PersistedOpenFile[]>,
  stranded: StrandedEditorDrafts
): Record<string, PersistedOpenFile[]> {
  for (const [ownerKey, drafts] of Object.entries(stranded)) {
    const live = byWorktree[ownerKey]
    if (!live) {
      byWorktree[ownerKey] = drafts
      continue
    }
    const unheld = drafts.filter((draft) => !live.some((file) => sameFileOwner(file, draft)))
    byWorktree[ownerKey] = [
      ...live.map(
        (file) =>
          (file.dirtyDraftContent === undefined &&
            drafts.find((draft) => sameFileOwner(file, draft))) ||
          file
      ),
      ...unheld
    ]
  }
  return byWorktree
}

/** Drops drafts whose text now lives in a recovered file. */
export function withoutRecoveredStrandedDrafts(
  stranded: StrandedEditorDrafts,
  recovered: ReadonlySet<PersistedOpenFile>
): StrandedEditorDrafts {
  if (recovered.size === 0) {
    return stranded
  }
  const next: StrandedEditorDrafts = {}
  for (const [ownerKey, drafts] of Object.entries(stranded)) {
    const kept = drafts.filter((file) => !recovered.has(file))
    if (kept.length > 0) {
      next[ownerKey] = kept.length === drafts.length ? drafts : kept
    }
  }
  return next
}
