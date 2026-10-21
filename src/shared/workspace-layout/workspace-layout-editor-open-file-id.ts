// The file id main gives a file it opens itself (CLI, phone, a host with no window).

import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import { editorTabFile, sameEditorFile } from './workspace-layout-editor-tab-file'
import type { LayoutEditorFile, WorkspaceLayout } from './workspace-layout-model'

type OpenedFile = Pick<LayoutEditorFile, 'filePath' | 'runtimeEnvironmentId'>

/**
 * The id an editor tab of the file already shows; else its owned id. Why never the bare path: the
 * window gives a path to one owner across every host, and main sees only this host's workspaces.
 */
export function editorOpenFileId(
  workspace: Pick<WorkspaceLayout, 'worktreeId' | 'tabs' | 'editorFiles'>,
  file: OpenedFile
): string {
  const shown = workspace.tabs.find((tab) => {
    const record = tab.kind === 'editor' ? editorTabFile(workspace, tab.entityId) : undefined
    return record !== undefined && sameEditorFile(record, file)
  })
  return (
    shown?.entityId ??
    ownedEditorFileId(file.filePath, workspace.worktreeId, file.runtimeEnvironmentId)
  )
}
