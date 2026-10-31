import { toast } from 'sonner'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import type { OpenFileOptions } from '../types/editor-files-slice'
import { workspaceAdmittedFiles } from '../../../workspace-admitted-files'
import { getOpenFileExecutionHostId } from '@/lib/unified-tab-host-ownership'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import {
  canReuseLocalWslAlias,
  getReusableOpenFileModes,
  isSameEditorOwner,
  matchesEditorMode,
  runtimeOwnerKey,
  resolveEditorFileIdForOwner
} from '../file-ids/editor-file-ids'

/** Display gestures resolve a compatible genuine resource before the strict raw update. */
export function resolveEditorOpenResource(
  s: AppState,
  file: Omit<OpenFile, 'id' | 'isDirty'>,
  options: OpenFileOptions | undefined
) {
  let operationProvenance = file.operationProvenance
  if (!operationProvenance && file.mode === 'edit' && file.readOnly !== true) {
    try {
      operationProvenance = captureEditorFileOperationProvenance(
        s,
        file.worktreeId,
        options?.suppressActiveRuntimeFallback ? null : file.runtimeEnvironmentId,
        options?.suppressActiveRuntimeFallback === true || file.runtimeEnvironmentId !== undefined
      )
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, 'Failed to resolve file owner.'))
      // Why: mirrored tabs can arrive before their graph row; allow convergence while mutation paths still fail closed without provenance.
    }
  }
  let runtimeEnvironmentId = operationProvenance
    ? operationProvenance.generation.route.runtimeEnvironmentId
    : file.runtimeEnvironmentId === null
      ? null
      : (file.runtimeEnvironmentId ??
        (options?.suppressActiveRuntimeFallback
          ? null
          : (s.settings?.activeRuntimeEnvironmentId?.trim() ?? undefined)))
  const reusableOpenFileModes = getReusableOpenFileModes(file.mode)
  const candidates = options?.displayWorkspaceId
    ? workspaceAdmittedFiles(s, options.displayWorkspaceId)
    : s.openFiles
  const compatible = (candidate: OpenFile): boolean =>
    matchesEditorMode(candidate, reusableOpenFileModes) &&
    (candidate.filePath === file.filePath ||
      canReuseLocalWslAlias(s, candidate, file, runtimeEnvironmentId))
  const existing =
    candidates.find(
      (candidate) =>
        compatible(candidate) && isSameEditorOwner(candidate, file.worktreeId, runtimeEnvironmentId)
    ) ??
    (options?.displayWorkspaceId === file.worktreeId
      ? candidates.find(
          (candidate) =>
            compatible(candidate) &&
            runtimeOwnerKey(candidate.runtimeEnvironmentId) ===
              runtimeOwnerKey(runtimeEnvironmentId) &&
            getOpenFileExecutionHostId(candidate) ===
              getOpenFileExecutionHostId({ ...file, runtimeEnvironmentId, operationProvenance })
        )
      : undefined)
  if (existing && existing.worktreeId !== file.worktreeId) {
    // Reuse changes the view, never the admitted resource's source or grant.
    file = {
      ...file,
      worktreeId: existing.worktreeId,
      runtimeEnvironmentId: existing.runtimeEnvironmentId,
      operationProvenance: existing.operationProvenance,
      externalSshTargetId: existing.externalSshTargetId
    }
    runtimeEnvironmentId = existing.runtimeEnvironmentId
    operationProvenance = existing.operationProvenance
  }
  // Already-open owner tabs outrank stale reopenId shapes; bare/namespaced drift otherwise points selection at no OpenFile.
  const id = existing
    ? existing.id
    : options?.reopenId && !s.openFiles.some((candidate) => candidate.id === options.reopenId)
      ? options.reopenId
      : resolveEditorFileIdForOwner(
          s,
          file.filePath,
          file.worktreeId,
          runtimeEnvironmentId,
          reusableOpenFileModes
        )
  return { file, existing, id, runtimeEnvironmentId, operationProvenance }
}
