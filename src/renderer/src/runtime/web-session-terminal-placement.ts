/**
 * Pending client-side placement for terminals created with a target group, keyed
 * by host tab id. The host silently drops group ids it has never seen (client
 * split-group ids are client-minted), so the client's own record is the only
 * authority that can land the mirrored tab in the pane that asked for it.
 * Records are consumed once the tab materializes; a lingering record would yank
 * a user-dragged tab back, so lifecycle is short by construction.
 */
type PendingTerminalPlacement = {
  groupId: string
  /** The user moved the tab after the create recorded its intent, so that intent is spent. */
  userMoved?: boolean
}

const placementByPendingHostTabId = new Map<string, PendingTerminalPlacement>()
const MAX_PENDING_TERMINAL_PLACEMENTS = 128

/** Create RPCs may return a surface id (`parent::leaf`); snapshots key terminals by the parent. */
export function webTerminalPlacementParentTabId(hostTabId: string): string {
  const separator = hostTabId.indexOf('::')
  return separator === -1 ? hostTabId : hostTabId.slice(0, separator)
}

function hostTabKey(environmentId: string, worktreeId: string, hostTabId: string): string {
  return `${environmentId}\0${worktreeId}\0${hostTabId}`
}

export function recordWebSessionTerminalPlacement(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
  groupId: string
}): void {
  const key = hostTabKey(args.environmentId, args.worktreeId, args.hostTabId)
  if (
    !placementByPendingHostTabId.has(key) &&
    placementByPendingHostTabId.size >= MAX_PENDING_TERMINAL_PLACEMENTS
  ) {
    const oldest = placementByPendingHostTabId.keys().next().value
    if (oldest !== undefined) {
      placementByPendingHostTabId.delete(oldest)
    }
  }
  placementByPendingHostTabId.set(key, { groupId: args.groupId })
}

/** Undefined once the user moved the tab: snapshots must keep it where the user put it. */
export function peekWebSessionTerminalPlacementGroup(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
}): string | undefined {
  const placement = placementByPendingHostTabId.get(
    hostTabKey(args.environmentId, args.worktreeId, args.hostTabId)
  )
  return placement?.userMoved ? undefined : placement?.groupId
}

/**
 * A local move of a tab whose create is still settling is the user's placement and beats the
 * create's. The entry stays so settlement can tell a user move from a mis-adopted tab.
 */
export function markWebSessionTerminalPlacementUserMoved(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
}): void {
  const key = hostTabKey(args.environmentId, args.worktreeId, args.hostTabId)
  const placement = placementByPendingHostTabId.get(key)
  if (placement && !placement.userMoved) {
    placementByPendingHostTabId.set(key, { ...placement, userMoved: true })
  }
}

export function isWebSessionTerminalPlacementUserMoved(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
}): boolean {
  return (
    placementByPendingHostTabId.get(hostTabKey(args.environmentId, args.worktreeId, args.hostTabId))
      ?.userMoved === true
  )
}

export function forgetWebSessionTerminalPlacement(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
}): void {
  placementByPendingHostTabId.delete(
    hostTabKey(args.environmentId, args.worktreeId, args.hostTabId)
  )
}

export function clearWebSessionTerminalPlacementsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const prefix = `${environmentId}\0${worktreeId}\0`
  for (const key of placementByPendingHostTabId.keys()) {
    if (key.startsWith(prefix)) {
      placementByPendingHostTabId.delete(key)
    }
  }
}

export function clearWebSessionTerminalPlacementsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of placementByPendingHostTabId.keys()) {
    if (key.startsWith(prefix)) {
      placementByPendingHostTabId.delete(key)
    }
  }
}

export function resetWebSessionTerminalPlacementsForTests(): void {
  placementByPendingHostTabId.clear()
}
