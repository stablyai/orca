// The window uses bare file paths or owner-qualified IDs for contested, floating or moved files.

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

/** Include runtime owner in owner-build keys because local/remote files can share paths; stream frame keys remain stable across builds. */
export const EDITOR_FILE_KEY_FIELDS: readonly (keyof FileOwner)[] = ORCA_LAYOUT_OWNER_IS_MAIN
  ? ['filePath', 'runtimeEnvironmentId']
  : ['filePath']

export function editorFileKey(file: FileOwner): string {
  // These maps are workspace-scoped, including during cross-workspace moves; omit worktree from their internal keys.
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? ownedEditorFileId(file.filePath, '', file.runtimeEnvironmentId)
    : file.filePath
}

export function sameEditorFile(a: FileOwner, b: FileOwner): boolean {
  return editorFileKey(a) === editorFileKey(b)
}

/** Whether an editor file id (a bare path or an owned id) names one of the workspace's records. */
export function holdsEditorFileId(
  workspace: { worktreeId: string; editorFiles?: readonly FileOwner[] },
  fileId: string
): boolean {
  return (
    workspace.editorFiles?.some((file) => editorTabShowsFile(fileId, file, workspace.worktreeId)) ??
    false
  )
}

type EditorWorkspace<F> = {
  worktreeId: string
  tabs: readonly { entityId: string }[]
  editorFiles?: readonly F[]
}

/** The record an editor tab shows; in a layout-owner build a bare path skips owned-id tabs' records. */
export function editorTabFile<F extends FileOwner>(
  workspace: EditorWorkspace<F>,
  entityId: string
): F | undefined {
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? editorTabFiles(workspace, entityId)[0]
    : workspace.editorFiles?.find((file) =>
        editorTabShowsFile(entityId, file, workspace.worktreeId)
      )
}

/** Whether an editor file id names this record, as `editorTabFile` resolves it. */
export function editorTabNamesFile<F extends FileOwner>(
  workspace: EditorWorkspace<F>,
  entityId: string,
  file: F
): boolean {
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? editorTabFile(workspace, entityId) === file
    : editorTabShowsFile(entityId, file, workspace.worktreeId)
}

/** A bare path belongs to only one owner; among matching records, skip those already claimed by an owned-ID tab. */
function editorTabFiles<F extends FileOwner>(workspace: EditorWorkspace<F>, entityId: string): F[] {
  const shown = (workspace.editorFiles ?? []).filter((file) =>
    editorTabShowsFile(entityId, file, workspace.worktreeId)
  )
  if (shown.length < 2) {
    return shown
  }
  const ids = new Set(workspace.tabs.map((tab) => tab.entityId))
  const unclaimed = shown.filter(
    (file) =>
      !ids.has(ownedEditorFileId(file.filePath, workspace.worktreeId, file.runtimeEnvironmentId))
  )
  return unclaimed.length > 0 ? unclaimed : shown
}

/** Whether a record stays once `entityId`'s last tab closed: not that tab's, or another tab's too. */
export function keptAfterEditorClose<F extends FileOwner>(
  before: EditorWorkspace<F>,
  after: { tabs: readonly { entityId: string }[] },
  entityId: string
): (file: F) => boolean {
  const closed = new Set(editorTabFiles(before, entityId))
  const shown = new Set(after.tabs.flatMap((tab) => editorTabFiles(before, tab.entityId)))
  return (file) => !closed.has(file) || shown.has(file)
}
