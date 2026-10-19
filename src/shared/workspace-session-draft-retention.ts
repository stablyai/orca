import type { WorkspaceSessionState } from './workspace-session-state-types'

/** Unsaved drafts the base held that the adopted rows lack: no other channel holds one. */
export function keepUnsavedDrafts(next: WorkspaceSessionState, base: WorkspaceSessionState): void {
  for (const [key, baseFiles] of Object.entries(base.openFilesByWorktree ?? {})) {
    const files = next.openFilesByWorktree?.[key] ?? []
    const drafts = new Map(
      baseFiles.filter((file) => file.dirtyDraftContent !== undefined).map((f) => [f.filePath, f])
    )
    if (files === baseFiles || drafts.size === 0) {
      continue
    }
    // A host entry with its own draft wins; a clean one yields to the base's draft for that path.
    const held = new Set(files.map((file) => file.filePath))
    const merged = [
      ...files.map(
        (file) => (file.dirtyDraftContent === undefined && drafts.get(file.filePath)) || file
      ),
      ...[...drafts.values()].filter((file) => !held.has(file.filePath))
    ]
    next.openFilesByWorktree = { ...next.openFilesByWorktree, [key]: merged }
  }
}
