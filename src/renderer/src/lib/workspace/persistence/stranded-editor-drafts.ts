import type { PersistedOpenFile } from '../../../../../shared/workspace-session/workspace-session-state-types'

/** Saved drafts of workspaces this window could not restore (folder gone while Orca was closed), by owner key; saves carry them verbatim until recovered. */
export type StrandedEditorDrafts = Record<string, PersistedOpenFile[]>

/** Writable files holding unsaved text; read-only tabs never restore a draft. */
export function strandedDraftFiles(files: readonly PersistedOpenFile[]): PersistedOpenFile[] {
  return files.filter((file) => file.readOnly !== true && file.dirtyDraftContent !== undefined)
}

function fileOwnerKey(file: PersistedOpenFile): string {
  return `${file.runtimeEnvironmentId ?? ''}\n${file.filePath}`
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
    const unheld = new Map(drafts.map((draft) => [fileOwnerKey(draft), draft]))
    const merged = live.map((file) => {
      const key = fileOwnerKey(file)
      const draft = unheld.get(key)
      unheld.delete(key)
      return (file.dirtyDraftContent === undefined && file.readOnly !== true && draft) || file
    })
    byWorktree[ownerKey] = [...merged, ...unheld.values()]
  }
  return byWorktree
}

/** Drops drafts whose text a recovered tab now holds. */
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
