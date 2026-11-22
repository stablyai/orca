import type { AppState } from '../../../types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeStatus } from '../../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { CrossStoreParentRef } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { lineageStoreKeyOfRow } from '../../../../../../shared/worktree/lineage/cross-store-lineage-resolution'
import { crossStoreParentRefOfRow } from '../../../../../../shared/worktree/lineage/lineage-row-identity'
import { assertCrossStoreLineageSupported } from '../../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { callRuntimeRpc } from '../../../../runtime/rpc/calls/runtime-rpc-call'
import { getRuntimeEnvironmentDisplayName } from '../../../repos/owner-routing'
import { selectLineageStoreInstallationId } from './cross-store-lineage-parents'
import type { RuntimeStatuses } from '../../runtime-status/views/runtime-status-owner'
import { lineageStoreKeyOfTarget } from './cross-store-lineage-state'
import { parseWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { isHome } from '../../../../../../shared/bots/bot-homes'
import { readBots } from '@/lib/bot-catalog-snapshot'
import { readBotGroups } from '@/lib/bot-group-catalog-snapshot'
import { findFolderWorkspaceRecord } from '../../../folder-workspaces/folder-workspace-record-index'
import { selectFolderWorkspaces } from '../../../workspaces/catalog/workspace-record-fields'

/** Whether a parent lives in another Orca store than the child, so the link needs a cross-store ref. */
export function isCrossStoreParent(child: Worktree, parent: Worktree): boolean {
  const childStore = lineageStoreKeyOfRow(child)
  const parentStore = lineageStoreKeyOfRow(parent)
  return childStore !== undefined && parentStore !== undefined && childStore !== parentStore
}

/** A bot's or group's home: the child's store saves it as a hand-over, which its cleanup never groups. */
export function isBotHomeParent(state: AppState, parent: Worktree): boolean {
  const scope = parseWorkspaceKey(parent.id)
  const folder =
    scope?.type === 'folder'
      ? findFolderWorkspaceRecord(
          selectFolderWorkspaces(state) ?? [],
          scope.folderWorkspaceId,
          parent.hostId ?? undefined
        )
      : undefined
  return Boolean(folder && isHome(folder, [...readBots(), ...readBotGroups()]))
}

/**
 * The ref a child in `childTarget`'s store saves, built from ids this window already verified: the
 * parent store's installationId and the picked row. Refuses before any write when the child's store
 * predates cross-machine parents or the parent's machine is unconfirmed.
 */
export async function buildCrossStoreParentRef(
  state: AppState,
  statuses: RuntimeStatuses,
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
  const ref = crossStoreParentRefOfRow(
    selectLineageStoreInstallationId(state, statuses, parentStore),
    parent
  )
  if (!ref) {
    throw new Error(
      "Couldn't confirm the parent's machine. Refresh the workspace list and try again."
    )
  }
  return ref
}
