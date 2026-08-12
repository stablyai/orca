const groupByPendingPage = new Map<string, string>()
const MAX_PENDING_PLACEMENTS = 128

function pageKey(environmentId: string, worktreeId: string, remotePageId: string): string {
  return `${environmentId}\0${worktreeId}\0${remotePageId}`
}

function worktreePrefix(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}\0`
}

export function recordWebSessionBrowserPlacement(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  groupId: string
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
  environmentId: string
  worktreeId: string
  groupId: string
}): boolean {
  const prefix = worktreePrefix(args.environmentId, args.worktreeId)
  for (const [key, groupId] of groupByPendingPage) {
    if (key.startsWith(prefix) && groupId === args.groupId) {
      return true
    }
  }
  return false
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
}

export function clearWebSessionBrowserPlacementsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of groupByPendingPage.keys()) {
    if (key.startsWith(prefix)) {
      groupByPendingPage.delete(key)
    }
  }
}

export function resetWebSessionBrowserPlacementsForTests(): void {
  groupByPendingPage.clear()
}
