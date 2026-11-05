import type { AppState } from '../../../types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import type { CrossStoreParentRef } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { lineageStoreKeyOfRow } from '../../../../../../shared/worktree/cross-store-lineage-resolution'
import { assertCrossStoreLineageSupported } from '../../../../../../shared/worktree-runtime-capabilities'
import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getRuntimeEnvironmentDisplayName } from '../../../repos/owner-routing'
import { selectLineageStoreInstallationId } from '../../../cross-store-lineage-parents'
import { lineageStoreKeyOfTarget } from './cross-store-lineage-state'

/** Whether a parent lives in another Orca store than the child, so the link needs a cross-store ref. */
export function isCrossStoreParent(child: Worktree, parent: Worktree): boolean {
  const childStore = lineageStoreKeyOfRow(child)
  const parentStore = lineageStoreKeyOfRow(parent)
  return childStore !== undefined && parentStore !== undefined && childStore !== parentStore
}

/**
 * The ref a child in `childTarget`'s store saves, built from ids this window already verified: the
 * parent store's installationId and the picked row. Refuses before any write when the child's store
 * predates cross-machine parents or the parent's machine is unconfirmed.
 */
export async function buildCrossStoreParentRef(
  state: AppState,
  childTarget: RuntimeClientTarget,
  parent: Worktree
): Promise<CrossStoreParentRef> {
  const childStatus = await callRuntimeRpc<RuntimeStatus>(childTarget, 'status.get')
  assertCrossStoreLineageSupported(
    childStatus.capabilities,
    childTarget.kind === 'environment'
      ? getRuntimeEnvironmentDisplayName(state, childTarget.environmentId)
      : 'this computer'
  )
  const parentStore = lineageStoreKeyOfRow(parent)
  if (parentStore === undefined || parentStore === lineageStoreKeyOfTarget(childTarget)) {
    throw new Error('That parent is on the same machine. Choose it as a parent there instead.')
  }
  if (parseWorkspaceKey(parent.id)?.type === 'folder') {
    throw new Error("A folder workspace can't parent a workspace on another machine yet.")
  }
  const installationId = selectLineageStoreInstallationId(state, parentStore)
  if (!installationId || !parent.instanceId) {
    throw new Error(
      "Couldn't confirm the parent's machine. Refresh the workspace list and try again."
    )
  }
  return {
    installationId,
    workspaceKey: worktreeWorkspaceKey(parent.id),
    instanceId: parent.instanceId
  }
}
