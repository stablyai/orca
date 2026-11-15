import type { WorktreeCreationRequest } from './pending-worktree-creation'

export type ProvisionedRootCreateOptions = {
  runtimeId: string
  executionHostId: NonNullable<WorktreeCreationRequest['workspaceRunContext']>['hostId']
  expectedPath: string
  expectedRefHead?: string
}

export function getProvisionedRootCreateOptions(
  request: WorktreeCreationRequest
): ProvisionedRootCreateOptions | null {
  if (request.ephemeralVmCheckoutMode !== 'provisioned-root') {
    return null
  }
  if (
    !request.ephemeralVmRuntimeId ||
    !request.workspaceRunContext ||
    (request.baseBranch && !request.ephemeralVmExpectedRefHead)
  ) {
    throw new Error('Provisioned-root workspace identity is incomplete.')
  }
  return {
    runtimeId: request.ephemeralVmRuntimeId,
    executionHostId: request.workspaceRunContext.hostId,
    expectedPath: request.workspaceRunContext.path,
    ...(request.ephemeralVmExpectedRefHead
      ? { expectedRefHead: request.ephemeralVmExpectedRefHead }
      : {})
  }
}
