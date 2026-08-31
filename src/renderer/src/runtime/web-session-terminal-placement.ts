/**
 * Pending client-side placement for terminals created with a target group, keyed
 * by host tab id. The host silently drops group ids it has never seen (client
 * split-group ids are client-minted), so the client's own record is the only
 * authority that can land the mirrored tab in the pane that asked for it.
 * Records are consumed once the tab materializes; a lingering record would yank
 * a user-dragged tab back, so lifecycle is short by construction.
 */
const groupByPendingHostTabId = new Map<string, string>()
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
    !groupByPendingHostTabId.has(key) &&
    groupByPendingHostTabId.size >= MAX_PENDING_TERMINAL_PLACEMENTS
  ) {
    const oldest = groupByPendingHostTabId.keys().next().value
    if (oldest !== undefined) {
      groupByPendingHostTabId.delete(oldest)
    }
  }
  groupByPendingHostTabId.set(key, args.groupId)
}

export function peekWebSessionTerminalPlacementGroup(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
}): string | undefined {
  return groupByPendingHostTabId.get(
    hostTabKey(args.environmentId, args.worktreeId, args.hostTabId)
  )
}

export function forgetWebSessionTerminalPlacement(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
}): void {
  groupByPendingHostTabId.delete(hostTabKey(args.environmentId, args.worktreeId, args.hostTabId))
}

export function clearWebSessionTerminalPlacementsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const prefix = `${environmentId}\0${worktreeId}\0`
  for (const key of groupByPendingHostTabId.keys()) {
    if (key.startsWith(prefix)) {
      groupByPendingHostTabId.delete(key)
    }
  }
}

export function clearWebSessionTerminalPlacementsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of groupByPendingHostTabId.keys()) {
    if (key.startsWith(prefix)) {
      groupByPendingHostTabId.delete(key)
    }
  }
}

export function resetWebSessionTerminalPlacementsForTests(): void {
  groupByPendingHostTabId.clear()
}
