import { useAppStore } from '@/store'
import { isWorkspaceStatusAllowedOnHost } from '@/store/host-workspace-status-columns'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'

/** A lane's host-only column applies only when creating on that host. */
export function resolveQuickCreationWorkspaceStatus(args: {
  status: WorkspaceStatus | null | undefined
  hostId: string | null | undefined
  runtimeOwnerEnvironmentId: string | null
}): WorkspaceStatus | undefined {
  const { status, hostId, runtimeOwnerEnvironmentId } = args
  return status &&
    isWorkspaceStatusAllowedOnHost(
      useAppStore.getState(),
      { hostId, runtimeOwnerEnvironmentId },
      status
    )
    ? status
    : undefined
}
