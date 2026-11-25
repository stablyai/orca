// How Hand to bot moves a workspace under the bot's home: the same Set Parent write a sidebar drop makes.
import { useAppStore } from '@/store'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { getDropFolderParentsInState } from '@/components/sidebar/workspace-actions/parenting/use-eligible-folder-parents'
import { isCrossStoreParent } from '@/store/slices/worktrees/metadata/cross-store-parent-ref'
import { getFolderWorkspaceWorktree } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { isHome } from '../../../../../shared/bots/bot-homes'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { Bot } from '../../../../../shared/bot-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { selectSidebarLineageParentIdentities } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

/** The bot's home as a Set Parent target for `child`; null when it isn't loaded or that store can't
 *  take a folder parent. */
export function botHomeParentFor(child: Worktree, bot: Bot): Worktree | null {
  const state = useAppStore.getState()
  const home = (selectFolderWorkspaces(state) ?? []).find((folder) => isHome(folder, [bot]))
  if (!home) {
    return null
  }
  const identity = getWorktreeHostIdentity(getFolderWorkspaceWorktree(home))
  return (
    getDropFolderParentsInState(state, readRuntimeStatuses(), child).find(
      (folder) => getWorktreeHostIdentity(folder) === identity
    ) ?? null
  )
}

/** Moves `child` under `parent`, as Set Parent does: a cross-machine ref for a paired computer's
 *  workspace. With `ifParentWorkspace`, the owning store writes only while that is still its parent. */
export async function moveUnderParent(
  child: Worktree,
  parent: Worktree,
  ifParentWorkspace?: string
): Promise<void> {
  const state = useAppStore.getState()
  const condition = ifParentWorkspace !== undefined ? { ifParentWorkspace } : {}
  if (isCrossStoreParent(child, parent)) {
    await state.assignCrossStoreWorktreeParent([child], parent, condition)
    return
  }
  await state.assignWorktreeParent(child.id, {
    parentWorktreeId: parent.id,
    ...(child.hostId ? { executionHostId: child.hostId } : {}),
    ...condition
  })
}

/** Where the workspace sits now, so a hand-over the bot refused can put it back. */
export function placementOf(child: Worktree): Worktree | null {
  const state = useAppStore.getState()
  const parent = selectSidebarLineageParentIdentities(state, readRuntimeStatuses())?.get(
    getWorktreeHostIdentity(child)
  )
  if (parent === undefined) {
    return null
  }
  const rows = [
    ...getIndexedAllWorktrees(selectWorktreesByRepo(state)),
    ...(selectFolderWorkspaces(state) ?? []).map((folder) => getFolderWorkspaceWorktree(folder))
  ]
  return rows.find((row) => getWorktreeHostIdentity(row) === parent) ?? null
}

/** Back under `parent` (as Set Parent puts it), or out of any parent when it had none, but only while
 *  it is still under `handedTo`: the owning store compares and writes in one step, so a move the owner
 *  made meanwhile stands. */
export async function restorePlacement(
  child: Worktree,
  parent: Worktree | null,
  handedTo: string
): Promise<void> {
  if (parent) {
    await moveUnderParent(child, parent, handedTo)
    return
  }
  await useAppStore.getState().updateWorktreeLineage(child.id, {
    noParent: true,
    ifParentWorkspace: handedTo,
    ...(child.hostId ? { executionHostId: child.hostId } : {})
  })
}
