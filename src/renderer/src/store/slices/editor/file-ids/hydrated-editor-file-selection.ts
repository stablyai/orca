import type { OpenFile } from '../types/open-file'
import { migrateEditorFileId } from './hydrated-editor-file-ids'

export function resolveHydratedEditorFileSelection(args: {
  openFiles: readonly Pick<OpenFile, 'id' | 'worktreeId'>[]
  validWorktreeIds: ReadonlySet<string>
  activeWorktreeId: string | null
  persistedActiveFileIds: Record<string, string | null>
  migrations: Record<string, Map<string, string>>
}): { activeFileId: string | null; activeFileIdByWorktree: Record<string, string> } {
  const workspaces = new Map<string, { firstFileId: string; ids: Set<string> }>()
  for (const file of args.openFiles) {
    let workspace = workspaces.get(file.worktreeId)
    if (!workspace) {
      workspace = { firstFileId: file.id, ids: new Set() }
      workspaces.set(file.worktreeId, workspace)
    }
    workspace.ids.add(file.id)
  }
  const selectedId = (worktreeId: string): string | null => {
    const workspace = workspaces.get(worktreeId)
    const persistedId = migrateEditorFileId(
      args.migrations,
      worktreeId,
      args.persistedActiveFileIds[worktreeId]
    )
    return persistedId && workspace?.ids.has(persistedId)
      ? persistedId
      : (workspace?.firstFileId ?? null)
  }
  return {
    activeFileId: args.activeWorktreeId ? selectedId(args.activeWorktreeId) : null,
    activeFileIdByWorktree: Object.fromEntries(
      [...args.validWorktreeIds].flatMap((worktreeId) => {
        const fileId = selectedId(worktreeId)
        return fileId ? [[worktreeId, fileId]] : []
      })
    )
  }
}
