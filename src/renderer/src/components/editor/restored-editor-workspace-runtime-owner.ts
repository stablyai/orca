import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { hasOpenFileExecutionHostEvidence } from '@/lib/unified-tab-host-ownership'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  findRuntimeWorkspaceFileRoute,
  type RuntimeWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'

export type RestoredEditorWorkspaceRuntimeOwner = {
  route: RuntimeWorkspaceFileRoute
  runtimeEnvironmentId: string
}

/**
 * The managed server a restored tab now belongs to, when its workspace moved there from an SSH
 * host. Such tabs name no host because the relay era derived it from the workspace, so they would
 * keep reading through the relay; they take the workspace's server instead, as a fresh open does.
 */
export function findRestoredEditorWorkspaceRuntimeOwner(
  state: AppState,
  file: OpenFile,
  worktreeId: string | undefined
): RestoredEditorWorkspaceRuntimeOwner | null {
  if (!worktreeId || file.worktreeId !== worktreeId || hasOpenFileExecutionHostEvidence(file)) {
    return null
  }
  const runtimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  // Why skip the focused server: its unstamped tabs already read and save there.
  if (
    !runtimeEnvironmentId ||
    runtimeEnvironmentId === state.settings?.activeRuntimeEnvironmentId?.trim()
  ) {
    return null
  }
  const route = findRuntimeWorkspaceFileRoute(state, runtimeEnvironmentId, file.filePath)
  return route?.worktreeId === worktreeId ? { route, runtimeEnvironmentId } : null
}
