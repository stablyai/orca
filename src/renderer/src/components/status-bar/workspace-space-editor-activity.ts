export type WorkspaceSpaceEditorActivity = {
  openFileCount: number
  dirtyBufferCount: number
}

export type WorkspaceSpaceEditorActivityFile = {
  id: string
  worktreeId: string
  isDirty: boolean
}

export function buildWorkspaceSpaceEditorActivityByWorktree(
  openFiles: readonly WorkspaceSpaceEditorActivityFile[],
  editorDrafts: Record<string, string>
): Map<string, WorkspaceSpaceEditorActivity> {
  const result = new Map<string, WorkspaceSpaceEditorActivity>()
  for (const file of openFiles) {
    const current = result.get(file.worktreeId) ?? { openFileCount: 0, dirtyBufferCount: 0 }
    current.openFileCount += 1
    if (file.isDirty || editorDrafts[file.id] !== undefined) {
      current.dirtyBufferCount += 1
    }
    result.set(file.worktreeId, current)
  }
  return result
}
