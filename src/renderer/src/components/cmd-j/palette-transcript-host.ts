import { resolveWorktreeFilterHostId, type PaletteFilterModel } from './palette-filter-options'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

/** A paired catalog's host-relative local row belongs to that runtime, never this desktop. */
export function paletteTranscriptWorkspaceHost(
  workspace: Worktree,
  filterModel: PaletteFilterModel
): ExecutionHostId | null {
  const host = parseRoutableExecutionHostId(
    resolveWorktreeFilterHostId(workspace, filterModel.repoById, LOCAL_EXECUTION_HOST_ID)
  )
  if (!host) {
    return null
  }
  const owner = workspace.runtimeOwnerEnvironmentId?.trim()
  if (!owner) {
    return host.id
  }
  const runtimeHost = toRuntimeExecutionHostId(owner)
  return host.kind === 'local' || host.id === runtimeHost ? runtimeHost : null
}
