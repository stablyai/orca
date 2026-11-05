import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import {
  buildRuntimeWorktreeCreateParams,
  type CreateWorktreeCallOptions,
  type WorktreeCreateAttempt,
  type WorktreeCreateRequest
} from './worktree-create-payload'

/** A recipe VM whose SSH host runs a managed server: that server adopts the root it checked out. */
export async function adoptRuntimeProvisionedRoot(
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
  request: WorktreeCreateRequest,
  attempt: WorktreeCreateAttempt,
  provisionedRoot: NonNullable<CreateWorktreeCallOptions['provisionedRoot']>
): Promise<CreateWorktreeResult> {
  const result = await callRuntimeRpc<CreateWorktreeResult>(
    target,
    'worktree.adoptProvisionedRoot',
    {
      ...buildRuntimeWorktreeCreateParams(request, attempt),
      expectedPath: provisionedRoot.expectedPath,
      ...(provisionedRoot.expectedRefHead
        ? { expectedRefHead: provisionedRoot.expectedRefHead }
        : {})
    },
    { timeoutMs: 60_000 }
  )
  // Why: removing the workspace later finds the VM to destroy through this desktop record.
  await window.api.ephemeralVm.attachWorkspace({
    runtimeId: provisionedRoot.runtimeId,
    workspaceId: result.worktree.id
  })
  return result
}
