import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import { editorTabFile, sameEditorFile } from './workspace-layout-editor-tab-file'
import type { LayoutEditorFile, WorkspaceLayout } from './workspace-layout-model'

type OpenedFile = Pick<LayoutEditorFile, 'filePath' | 'runtimeEnvironmentId'>

/** Reuse a displayed file ID, otherwise use its owned ID. Bare paths belong to one owner across hosts, beyond main’s partition-local view. */
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
