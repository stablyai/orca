import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'
import type { EditorRecoveryDraft, EditorRecoveryMetadata } from './editor-recovery'
import type { PersistedOpenFile, WorkspaceSessionState } from './workspace-session-state-types'

export function editorRecoverySessionFileMetadata(
  file: PersistedOpenFile,
  worktreeId: string,
  hostId: string
): EditorRecoveryMetadata {
  return {
    hostId: file.externalSshTargetId ? toSshExecutionHostId(file.externalSshTargetId) : hostId,
    worktreeId,
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    bufferKind: file.recoveryBufferKind === 'diff' ? 'diff' : 'edit',
    runtimeEnvironmentId: file.runtimeEnvironmentId,
    externalSshTargetId: file.externalSshTargetId,
    lastKnownDiskSignature: file.lastKnownDiskSignature
  }
}
export function editorRecoverySessionCheckpointIds(session: WorkspaceSessionState): string[] {
  return Object.values(session.openFilesByWorktree ?? {}).flatMap((files) =>
    files.flatMap((file) => (file.recoveryId ? [file.recoveryId] : []))
  )
}

export function editorRecoverySessionResources(
  session: WorkspaceSessionState,
  host?: string | null
): EditorRecoveryMetadata[] {
  const hostId = normalizeExecutionHostId(host) ?? LOCAL_EXECUTION_HOST_ID
  return Object.entries(session.openFilesByWorktree ?? {}).flatMap(([worktreeId, files]) =>
    files
      .filter((file) => !file.readOnly)
      .map((file) => editorRecoverySessionFileMetadata(file, worktreeId, hostId))
  )
}

export function applyEditorRecoverySessionDrafts(
  session: WorkspaceSessionState,
  drafts: readonly (EditorRecoveryDraft | null)[],
  resolvedIds: ReadonlySet<string> = new Set()
): WorkspaceSessionState {
  let index = 0
  const openFilesByWorktree = Object.fromEntries(
    Object.entries(session.openFilesByWorktree ?? {}).map(([worktreeId, files]) => [
      worktreeId,
      files.map((file) => {
        if (file.readOnly) {
          return file
        }
        const draft = drafts[index++]
        if (file.recoveryId && resolvedIds.has(file.recoveryId)) {
          const {
            dirtyDraftContent: _content,
            recoveryId: _id,
            recoveryRevision: _revision,
            ...clean
          } = file
          return clean
        }
        if (!draft) {
          return file
        }
        // An unversioned snapshot can be a newer edit made by a rolled-back client.
        if (
          file.dirtyDraftContent !== undefined &&
          !file.recoveryId &&
          file.dirtyDraftContent !== draft.content
        ) {
          return file
        }
        if (
          file.recoveryRevision !== undefined &&
          draft.id === file.recoveryId &&
          (file.recoveryRevision > draft.revision ||
            (file.recoveryRevision === draft.revision &&
              file.dirtyDraftContent !== undefined &&
              file.dirtyDraftContent !== draft.content))
        ) {
          // This snapshot has text the journal never acknowledged; checkpoint it under a fresh ID.
          const { recoveryId: _id, recoveryRevision: _revision, ...uncheckpointed } = file
          return uncheckpointed
        }
        return {
          ...file,
          dirtyDraftContent: draft.content,
          lastKnownDiskSignature: draft.lastKnownDiskSignature,
          recoveryId: draft.id,
          recoveryRevision: draft.revision,
          recoveryBufferKind: file.recoveryBufferKind ?? draft.bufferKind
        }
      })
    ])
  )
  return { ...session, openFilesByWorktree }
}
