import type { AppState } from '@/store'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { EditorPopoutOpenRequest } from '../../../../shared/editor-popout'

export function createEditorPopoutOpenRequest({
  state,
  file,
  content,
  savedContent,
  viewMode,
  showFrontmatter
}: {
  state: AppState
  file: OpenFile
  content: string
  savedContent: string
  viewMode: MarkdownViewMode
  showFrontmatter: boolean
}): EditorPopoutOpenRequest | null {
  if (
    file.mode !== 'edit' ||
    file.language !== 'markdown' ||
    file.isUntitled === true ||
    file.readOnly === true
  ) {
    return null
  }
  const worktree = findWorktreeById(state.worktreesByRepo ?? {}, file.worktreeId)
  const owner = getEditorFileOperationContext(state, file, worktree?.path ?? null)
  const expectedEnvironmentPairingRevision = file.runtimeEnvironmentId
    ? getRuntimeEnvironmentRevision(file.runtimeEnvironmentId)
    : undefined
  if (file.runtimeEnvironmentId && expectedEnvironmentPairingRevision === undefined) {
    return null
  }
  return {
    document: {
      id: file.id,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      language: 'markdown',
      ...(file.runtimeEnvironmentId === undefined
        ? {}
        : { runtimeEnvironmentId: file.runtimeEnvironmentId }),
      ...(file.externalSshTargetId ? { externalSshTargetId: file.externalSshTargetId } : {})
    },
    content,
    savedContent,
    viewMode,
    showFrontmatter,
    operationContext: {
      settings: owner.settings
        ? { activeRuntimeEnvironmentId: owner.settings.activeRuntimeEnvironmentId ?? null }
        : null,
      worktreeId: owner.worktreeId,
      worktreePath: owner.worktreePath,
      expectedExecutionHostId: owner.expectedExecutionHostId,
      ...(owner.connectionId ? { connectionId: owner.connectionId } : {}),
      ...(owner.expectedSshTargetId ? { expectedSshTargetId: owner.expectedSshTargetId } : {}),
      ...(owner.expectedSshConnectionGeneration === undefined
        ? {}
        : { expectedSshConnectionGeneration: owner.expectedSshConnectionGeneration }),
      ...(expectedEnvironmentPairingRevision === undefined
        ? {}
        : { expectedEnvironmentPairingRevision }),
      ...(file.externalSshTargetId ? { expectedExternalSshTargetId: file.externalSshTargetId } : {})
    }
  }
}
