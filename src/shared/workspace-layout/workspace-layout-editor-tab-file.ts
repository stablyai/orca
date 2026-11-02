// Which file an editor tab shows. The window keys a file by its path, or by its owned id when
// another owner holds the path, it is floating, or it moved to its file's workspace.

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'
import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import type { LayoutEditorFile } from './workspace-layout-model'

type FileOwner = Pick<LayoutEditorFile, 'filePath' | 'runtimeEnvironmentId'>

export function editorTabShowsFile(entityId: string, file: FileOwner, worktreeId: string): boolean {
  return (
    entityId === file.filePath ||
    // Why the switch: a headless host saves through this code in shipped builds too.
    (ORCA_LAYOUT_OWNER_IS_MAIN &&
      entityId === ownedEditorFileId(file.filePath, worktreeId, file.runtimeEnvironmentId))
  )
}

export function editorTabFile<F extends FileOwner>(
  workspace: { worktreeId: string; editorFiles?: readonly F[] },
  entityId: string
): F | undefined {
  return workspace.editorFiles?.find((file) =>
    editorTabShowsFile(entityId, file, workspace.worktreeId)
  )
}
