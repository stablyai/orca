import type { PersistedOpenFile } from '../../../../../shared/workspace-session/workspace-session-state-types'

/** Saved drafts of workspaces this window could not restore (folder gone while Orca was closed), by owner key; saves carry them verbatim until recovered. */
export type StrandedEditorDrafts = Record<string, PersistedOpenFile[]>

export type StrandedEditorDraftRef = { ownerKey: string; filePath: string }

/** Writable files holding unsaved text; read-only tabs never restore a draft. */
export function strandedDraftFiles(files: readonly PersistedOpenFile[]): PersistedOpenFile[] {
  return files.filter((file) => file.readOnly !== true && file.dirtyDraftContent !== undefined)
}

/** Live tabs win for a path they hold; stranded drafts fill in the rest of their owner. */
export function withStrandedEditorDrafts(
  byWorktree: Record<string, PersistedOpenFile[]>,
  stranded: StrandedEditorDrafts
): Record<string, PersistedOpenFile[]> {
  for (const [ownerKey, drafts] of Object.entries(stranded)) {
    const live = byWorktree[ownerKey] ?? []
    const held = new Set(live.map((file) => file.filePath))
    const kept = drafts.filter((file) => !held.has(file.filePath))
    if (kept.length > 0) {
      byWorktree[ownerKey] = [...live, ...kept]
    }
  }
  return byWorktree
}

/** Drops drafts whose text now lives in a recovered file. */
export function withoutRecoveredStrandedDrafts(
  stranded: StrandedEditorDrafts,
  recovered: readonly StrandedEditorDraftRef[]
): StrandedEditorDrafts {
  if (recovered.length === 0) {
    return stranded
  }
  const next: StrandedEditorDrafts = {}
  for (const [ownerKey, drafts] of Object.entries(stranded)) {
    const kept = drafts.filter(
      (file) =>
        !recovered.some((ref) => ref.ownerKey === ownerKey && ref.filePath === file.filePath)
    )
    if (kept.length > 0) {
      next[ownerKey] = kept
    }
  }
  return next
}
