import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { Tab } from '../../../../../shared/tab-types'

/** Sessions predating the unified strip stored editor membership in the saved file list. */
export function legacyEditorTabs(session: WorkspaceSessionState): Record<string, Tab[]> {
  return Object.fromEntries(
    Object.entries(session.openFilesByWorktree ?? {}).map(([worktreeId, files]) => [
      worktreeId,
      files.map((file, index) => ({
        id: file.filePath,
        entityId: file.filePath,
        worktreeId,
        groupId: `legacy-editor:${worktreeId}`,
        contentType: 'editor',
        label: file.relativePath,
        customLabel: null,
        color: null,
        sortOrder: index,
        createdAt: 0,
        ...(file.isPreview ? { isPreview: true } : {})
      }))
    ])
  )
}
