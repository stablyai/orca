const groupByPendingPage = new Map<string, string>()
const callerCreatedGroups = new Set<string>()
const MAX_PENDING_PLACEMENTS = 128

function pageKey(environmentId: string, worktreeId: string, remotePageId: string): string {
  return `${environmentId}\0${worktreeId}\0${remotePageId}`
}

function worktreePrefix(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}\0`
}

function environmentPrefix(environmentId: string): string {
  return `${environmentId}\0`
}

function groupKey(worktreeId: string, groupId: string): string {
  return `${worktreeId}\0${groupId}`
}

function reserveCallerCreatedGroup(worktreeId: string, groupId: string): void {
  const key = groupKey(worktreeId, groupId)
  callerCreatedGroups.delete(key)
  if (callerCreatedGroups.size >= MAX_PENDING_PLACEMENTS) {
    const oldest = callerCreatedGroups.values().next().value
    if (oldest !== undefined) {
      callerCreatedGroups.delete(oldest)
    }
  }
  callerCreatedGroups.add(key)
}

function clearUnreservedCallerCreatedGroups(worktreeId?: string): void {
  const worktreePrefix = worktreeId ? `${worktreeId}\0` : null
  for (const key of callerCreatedGroups) {
    if (worktreePrefix && !key.startsWith(worktreePrefix)) {
      continue
    }
    const separator = key.indexOf('\0')
    const keyWorktreeId = key.slice(0, separator)
    const groupId = key.slice(separator + 1)
    if (!isWebSessionBrowserPlacementGroupReserved({ worktreeId: keyWorktreeId, groupId })) {
      callerCreatedGroups.delete(key)
    }
  }
}

export function recordWebSessionBrowserPlacement(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  groupId: string
  callerCreatedGroup?: boolean
}): void {
  const key = pageKey(args.environmentId, args.worktreeId, args.remotePageId)
  groupByPendingPage.delete(key)
  if (groupByPendingPage.size >= MAX_PENDING_PLACEMENTS) {
    const oldest = groupByPendingPage.keys().next().value
    if (oldest !== undefined) {
      groupByPendingPage.delete(oldest)
    }
  }
  groupByPendingPage.set(key, args.groupId)
  if (args.callerCreatedGroup) {
    reserveCallerCreatedGroup(args.worktreeId, args.groupId)
  }
}

export function moveWebSessionBrowserPlacement(args: {
  environmentId: string
  worktreeId: string
  fromRemotePageId: string
  toRemotePageId: string
}): void {
  const fromKey = pageKey(args.environmentId, args.worktreeId, args.fromRemotePageId)
  const groupId = groupByPendingPage.get(fromKey)
  groupByPendingPage.delete(fromKey)
  if (groupId) {
    recordWebSessionBrowserPlacement({
      environmentId: args.environmentId,
      worktreeId: args.worktreeId,
      remotePageId: args.toRemotePageId,
      groupId
    })
  }
}

export function forgetWebSessionBrowserPlacement(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
}): void {
  groupByPendingPage.delete(pageKey(args.environmentId, args.worktreeId, args.remotePageId))
}

export function takeWebSessionBrowserPlacementGroup(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
}): string | undefined {
  const key = pageKey(args.environmentId, args.worktreeId, args.remotePageId)
  const groupId = groupByPendingPage.get(key)
  groupByPendingPage.delete(key)
  return groupId
}

export function isWebSessionBrowserPlacementGroupReserved(args: {
  worktreeId: string
  groupId: string
}): boolean {
  const worktreeMarker = `\0${args.worktreeId}\0`
  for (const [key, groupId] of groupByPendingPage) {
    if (key.includes(worktreeMarker) && groupId === args.groupId) {
      return true
    }
  }
  return false
}

export function releaseWebSessionBrowserPlacementGroup(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  groupId: string
  callerCreatedGroup: boolean
}): boolean {
  forgetWebSessionBrowserPlacement(args)
  if (args.callerCreatedGroup) {
    reserveCallerCreatedGroup(args.worktreeId, args.groupId)
  }
  const key = groupKey(args.worktreeId, args.groupId)
  if (
    !callerCreatedGroups.has(key) ||
    isWebSessionBrowserPlacementGroupReserved({
      worktreeId: args.worktreeId,
      groupId: args.groupId
    })
  ) {
    return false
  }
  callerCreatedGroups.delete(key)
  return true
}

export function completeWebSessionBrowserPlacementGroup(
  worktreeId: string,
  groupId: string | undefined
): void {
  if (groupId) {
    callerCreatedGroups.delete(groupKey(worktreeId, groupId))
  }
}

export function clearWebSessionBrowserPlacementsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const prefix = worktreePrefix(environmentId, worktreeId)
  for (const key of groupByPendingPage.keys()) {
    if (key.startsWith(prefix)) {
      groupByPendingPage.delete(key)
    }
  }
  clearUnreservedCallerCreatedGroups(worktreeId)
}

export function clearWebSessionBrowserPlacementsForEnvironment(environmentId: string): void {
  const prefix = environmentPrefix(environmentId)
  for (const key of groupByPendingPage.keys()) {
    if (key.startsWith(prefix)) {
      groupByPendingPage.delete(key)
    }
  }
  clearUnreservedCallerCreatedGroups()
}

export function resetWebSessionBrowserPlacementsForTests(): void {
  groupByPendingPage.clear()
  callerCreatedGroups.clear()
}
