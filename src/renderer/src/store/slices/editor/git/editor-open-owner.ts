import type { AppState } from '../../../types'
import type { EditorOpenTargetOptions } from '../types/open-file'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { resolveDiffRuntimeEnvironmentId } from './diff-runtime-owner'

export function editorOpenOwner(
  state: AppState,
  worktreeId: string,
  options?: EditorOpenTargetOptions
) {
  const capture = () =>
    captureEditorFileOperationProvenance(
      state,
      worktreeId,
      options?.runtimeEnvironmentId,
      options?.runtimeEnvironmentId !== undefined,
      options?.executionHostId
    )
  let operationProvenance
  if (options?.executionHostId) {
    operationProvenance = capture()
  } else {
    try {
      operationProvenance = capture()
    } catch {
      /* Legacy records can precede their catalog. */
    }
  }
  const hostId = operationProvenance?.generation.route.executionHostId

  return {
    runtimeEnvironmentId:
      operationProvenance?.generation.route.runtimeEnvironmentId ??
      resolveDiffRuntimeEnvironmentId(state, worktreeId, options?.runtimeEnvironmentId),
    ...(operationProvenance ? { operationProvenance } : {}),
    ...(hostId?.startsWith('ssh:')
      ? { externalSshTargetId: decodeURIComponent(hostId.slice(4)) }
      : {})
  }
}

/** Host is content identity; placement never changes an editor's id. */
export function qualifyEditorContentId(
  id: string,
  runtimeEnvironmentId?: string | null,
  executionHostId?: string
): string {
  const owner = executionHostId?.startsWith('ssh:') ? executionHostId : runtimeEnvironmentId
  return owner ? `${id}::owner::${encodeURIComponent(owner)}` : id
}
