import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { hasOpenFileExecutionHostEvidence } from '@/lib/unified-tab-host-ownership'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import {
  findRuntimeWorkspaceFileRoute,
  type RuntimeWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'

export type RestoredEditorWorkspaceRuntimeOwner = {
  route: RuntimeWorkspaceFileRoute
  runtimeEnvironmentId: string
}

/** Migrate unstamped relay-era tabs to their workspace’s managed server so reads and saves do not retain the old SSH route. */
export function findRestoredEditorWorkspaceRuntimeOwner(
  state: AppState,
  file: Pick<
    OpenFile,
    | 'worktreeId'
    | 'filePath'
    | 'externalSshTargetId'
    | 'operationProvenance'
    | 'runtimeEnvironmentId'
  >,
  worktreeId: string | undefined
): RestoredEditorWorkspaceRuntimeOwner | null {
  if (!worktreeId || file.worktreeId !== worktreeId || hasOpenFileExecutionHostEvidence(file)) {
    return null
  }
  // Why: re-homing a tab moves where it saves; a twin keeps the tab where it was.
  const runtimeEnvironmentId = runtimeEnvironmentIdUnlessTwin(state, worktreeId)
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
