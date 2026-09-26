import type { Tab } from './tab-types'
import type { PersistedOpenFile } from './workspace-session-state-types'

type EditorFileOwner = Pick<PersistedOpenFile, 'filePath' | 'runtimeEnvironmentId'>

/** Id an editor takes when another worktree or runtime already holds its path as a plain id. */
export function formatOwnedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

/** The open file an editor id names, by its workspace-scoped id first, else its plain path. */
export function findOpenFileByEditorId<T extends EditorFileOwner>(
  files: readonly T[],
  worktreeId: string,
  fileId: string | null | undefined
): T | undefined {
  if (!fileId) {
    return undefined
  }
  return (
    files.find(
      (file) =>
        formatOwnedEditorFileId(file.filePath, worktreeId, file.runtimeEnvironmentId) === fileId
    ) ?? files.find((file) => file.filePath === fileId)
  )
}

/** Points an editor tab at its backing file path, the only editor identity another host shares. */
export function withEditorBackingPath<T extends Pick<Tab, 'contentType' | 'entityId'>>(
  tab: T,
  files: readonly EditorFileOwner[],
  worktreeId: string
): T {
  const file =
    tab.contentType === 'editor' ? findOpenFileByEditorId(files, worktreeId, tab.entityId) : null
  return file ? { ...tab, entityId: file.filePath } : tab
}
