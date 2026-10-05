import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { EditorRecoveryMetadata } from '../../../shared/editor-recovery'
import { buildHostIdByWorktreeId } from './workspace-session-host-persistence'

export function canRecoverEditorBuffer(
  file: Pick<OpenFile, 'mode' | 'diffSource' | 'readOnly'>
): boolean {
  return (
    file.readOnly !== true &&
    (file.mode === 'edit' || (file.mode === 'diff' && file.diffSource === 'unstaged'))
  )
}

export function captureEditorRecoveryMetadata(
  file: OpenFile,
  state: AppState,
  hostForWorktree?: ReturnType<typeof buildHostIdByWorktreeId>
): EditorRecoveryMetadata {
  const capturedHost = file.operationProvenance?.generation.route.executionHostId
  const hostId = file.externalSshTargetId
    ? toSshExecutionHostId(file.externalSshTargetId)
    : (capturedHost ??
      (file.runtimeEnvironmentId
        ? toRuntimeExecutionHostId(file.runtimeEnvironmentId)
        : (hostForWorktree ?? buildHostIdByWorktreeId(state))(file.worktreeId)))
  return {
    hostId,
    worktreeId: file.worktreeId,
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    bufferKind: file.recoveryBufferKind === 'diff' || file.mode === 'diff' ? 'diff' : 'edit',
    runtimeEnvironmentId: file.runtimeEnvironmentId,
    externalSshTargetId: file.externalSshTargetId,
    lastKnownDiskSignature: file.lastKnownDiskSignature
  }
}
