import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { Worktree } from '../../../../../shared/worktree/types'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'

type WorktreeHostAliases = Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>

export type UnifiedTabCreatePlacementInput = {
  groups: readonly TabGroup[]
  tabs: readonly Tab[]
  activeGroupId: string | undefined
  targetGroupId?: string
  afterTabId?: string
  /** The caller's verified host; an anchor owned by another host is foreign. */
  executionHostId?: ExecutionHostId
  /** Records sharing this worktree id; host aliases only count when exactly one exists. */
  lookupWorktrees: () => readonly WorktreeHostAliases[]
}

export type UnifiedTabCreatePlacement = {
  /** A live group, or undefined to let ensureGroup pick its first-group/new-root fallback. */
  groupId: string | undefined
  anchorTabId: string | undefined
}

function isAnchorHostCompatible(
  anchorHostId: ExecutionHostId | undefined,
  input: UnifiedTabCreatePlacementInput
): boolean {
  const requestedHostId = input.executionHostId
  if (!requestedHostId || !anchorHostId || anchorHostId === requestedHostId) {
    return true
  }
  const worktrees = input.lookupWorktrees()
  return (
    worktrees.length === 1 &&
    isExecutionHostAliasForWorktree(requestedHostId, worktrees[0]) &&
    isExecutionHostAliasForWorktree(anchorHostId, worktrees[0])
  )
}

function resolveAnchor(input: UnifiedTabCreatePlacementInput): Tab | undefined {
  if (!input.afterTabId) {
    return undefined
  }
  const matches = input.tabs.filter((tab) => tab.id === input.afterTabId)
  if (matches.length !== 1) {
    return undefined
  }
  const anchor = matches[0]
  const group = input.groups.find((candidate) => candidate.id === anchor.groupId)
  if (!group?.tabOrder.includes(anchor.id)) {
    return undefined
  }
  return isAnchorHostCompatible(anchor.executionHostId, input) ? anchor : undefined
}

/** Resolve a new tab's destination group and the live anchor it should follow there. */
export function resolveUnifiedTabCreatePlacement(
  input: UnifiedTabCreatePlacementInput
): UnifiedTabCreatePlacement {
  const isLiveGroup = (groupId: string | undefined): groupId is string =>
    Boolean(groupId && input.groups.some((group) => group.id === groupId))
  const anchor = resolveAnchor(input)
  // Why validate first: an expired requested id must fall to the active group, not ensureGroup's first group.
  const groupId = isLiveGroup(input.targetGroupId)
    ? input.targetGroupId
    : (anchor?.groupId ?? (isLiveGroup(input.activeGroupId) ? input.activeGroupId : undefined))
  return {
    groupId,
    anchorTabId: anchor && anchor.groupId === groupId ? anchor.id : undefined
  }
}
