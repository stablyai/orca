import type { AuxWindowBounds } from '../../../../shared/aux-window'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { buildDetachedTabGroupIntegrityPatch } from './detached-tab-groups'

type DetachedState = {
  detachedGroupIds: string[]
  auxWindowBoundsByGroupId: Record<string, AuxWindowBounds>
  groupsByWorktree: Record<string, TabGroup[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
}

function groupOwners(groupsByWorktree: Record<string, TabGroup[]>): Map<string, string> {
  const owners = new Map<string, string>()
  for (const [worktreeId, groups] of Object.entries(groupsByWorktree)) {
    for (const group of groups) {
      owners.set(group.id, worktreeId)
    }
  }
  return owners
}

export function mergePartialDetachedTabGroupHydration(args: {
  current: DetachedState
  incoming: Pick<DetachedState, 'detachedGroupIds' | 'auxWindowBoundsByGroupId'>
  nextGroupsByWorktree: Record<string, TabGroup[]>
  nextUnifiedTabsByWorktree: Record<string, Tab[]>
  replaceWorkspaceKeys: ReadonlySet<string>
}): Pick<DetachedState, 'detachedGroupIds' | 'auxWindowBoundsByGroupId'> {
  const currentOwners = groupOwners(args.current.groupsByWorktree)
  const nextOwners = groupOwners(args.nextGroupsByWorktree)
  const retainedIds = args.current.detachedGroupIds.filter((groupId) => {
    const owner = currentOwners.get(groupId)
    return owner !== undefined && !args.replaceWorkspaceKeys.has(owner)
  })
  const incomingIds = args.incoming.detachedGroupIds.filter((groupId) => {
    const owner = nextOwners.get(groupId)
    return owner !== undefined && args.replaceWorkspaceKeys.has(owner)
  })
  const detachedGroupIds = [...new Set([...retainedIds, ...incomingIds])]
  const auxWindowBoundsByGroupId = Object.fromEntries(
    [...nextOwners].flatMap(([groupId, owner]) => {
      const bounds = args.replaceWorkspaceKeys.has(owner)
        ? args.incoming.auxWindowBoundsByGroupId[groupId]
        : args.current.auxWindowBoundsByGroupId[groupId]
      return bounds ? [[groupId, bounds] as const] : []
    })
  )
  const candidate = {
    detachedGroupIds,
    auxWindowBoundsByGroupId,
    groupsByWorktree: args.nextGroupsByWorktree,
    unifiedTabsByWorktree: args.nextUnifiedTabsByWorktree
  }
  const patch = buildDetachedTabGroupIntegrityPatch(candidate)
  return {
    detachedGroupIds: patch.detachedGroupIds ?? detachedGroupIds,
    auxWindowBoundsByGroupId: patch.auxWindowBoundsByGroupId ?? auxWindowBoundsByGroupId
  }
}
