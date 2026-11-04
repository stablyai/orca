import type { AppState } from '../../../types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import type { CrossStoreParentRef } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  lineageStoreKeyOfRow,
  OWN_LINEAGE_STORE_KEY
} from '../../../../../../shared/worktree/cross-store-lineage-resolution'
import { assertCrossStoreLineageSupported } from '../../../../../../shared/worktree-runtime-capabilities'
import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import { getRuntimeEnvironmentDisplayName } from '../../../repos/owner-routing'
import { selectLineageStoreInstallationId } from '../../../cross-store-lineage-parents'
import { lineageStoreKeyOfTarget } from './cross-store-lineage-state'

function targetOfStore(storeKey: string): RuntimeClientTarget {
  return storeKey === OWN_LINEAGE_STORE_KEY
    ? { kind: 'local' }
    : { kind: 'environment', environmentId: storeKey }
}

/** Whether a parent lives in another Orca store than the child, so the link needs a cross-store ref. */
export function isCrossStoreParent(child: Worktree, parent: Worktree): boolean {
  const childStore = lineageStoreKeyOfRow(child)
  const parentStore = lineageStoreKeyOfRow(parent)
  return childStore !== undefined && parentStore !== undefined && childStore !== parentStore
}

/**
 * The parent's own store names it for a child in `childTarget`'s store. Refuses before any write when
 * the child's store can't save it, or when the named install isn't the one this window verified.
 */
export async function mintCrossStoreParentRef(
  state: AppState,
  childTarget: RuntimeClientTarget,
  parent: Worktree,
  options: { reparent: boolean }
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
  const { parent: ref } = await callRuntimeRpc<{ parent: CrossStoreParentRef }>(
    targetOfStore(parentStore),
    'worktree.crossStoreParentRef',
    {
      worktree: toRuntimeWorktreeSelector(parent.id),
      ...(options.reparent ? { reparent: true } : {})
    },
    { timeoutMs: 15_000 }
  )
  const verified = selectLineageStoreInstallationId(state, parentStore)
  if (!verified || ref.installationId !== verified || ref.instanceId !== parent.instanceId) {
    throw new Error(
      "Couldn't confirm the parent's machine. Refresh the workspace list and try again."
    )
  }
  return ref
}
