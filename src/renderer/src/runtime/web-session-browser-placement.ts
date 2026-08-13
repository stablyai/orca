type PendingBrowserPlacement = {
  groupId: string
  ownsGroupCleanup: boolean
}

const placementByPendingPage = new Map<string, PendingBrowserPlacement>()
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
  callerCreatedGroup?: boolean
}): void {
  const key = pageKey(args.environmentId, args.worktreeId, args.remotePageId)
  const existing = placementByPendingPage.get(key)
  if (!existing && placementByPendingPage.size >= MAX_PENDING_PLACEMENTS) {
    throw new Error('Too many paired browser placements are pending.')
  }
  placementByPendingPage.set(key, {
    groupId: args.groupId,
    ownsGroupCleanup: args.callerCreatedGroup === true || existing?.ownsGroupCleanup === true
  })
}

export function moveWebSessionBrowserPlacement(args: {
  environmentId: string
  worktreeId: string
  fromRemotePageId: string
  toRemotePageId: string
}): void {
  const fromKey = pageKey(args.environmentId, args.worktreeId, args.fromRemotePageId)
  const placement = placementByPendingPage.get(fromKey)
  placementByPendingPage.delete(fromKey)
  if (placement) {
    recordWebSessionBrowserPlacement({
      environmentId: args.environmentId,
      worktreeId: args.worktreeId,
      remotePageId: args.toRemotePageId,
      groupId: placement.groupId,
      callerCreatedGroup: placement.ownsGroupCleanup
    })
  }
}

export function forgetWebSessionBrowserPlacement(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
}): void {
  placementByPendingPage.delete(pageKey(args.environmentId, args.worktreeId, args.remotePageId))
}

export function takeWebSessionBrowserPlacementGroup(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
}): string | undefined {
  const key = pageKey(args.environmentId, args.worktreeId, args.remotePageId)
  const placement = placementByPendingPage.get(key)
  placementByPendingPage.delete(key)
  return placement?.groupId
}

export function isWebSessionBrowserPlacementGroupReserved(args: {
  worktreeId: string
  groupId: string
}): boolean {
  const worktreeMarker = `\0${args.worktreeId}\0`
  for (const [key, placement] of placementByPendingPage) {
    if (key.includes(worktreeMarker) && placement.groupId === args.groupId) {
      return true
    }
  }
  return false
}

export function releaseWebSessionBrowserPlacementGroup(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  callerCreatedGroup: boolean
}): boolean {
  const key = pageKey(args.environmentId, args.worktreeId, args.remotePageId)
  const placement = placementByPendingPage.get(key)
  placementByPendingPage.delete(key)
  return args.callerCreatedGroup || placement?.ownsGroupCleanup === true
}

export function claimWebSessionBrowserPlacementGroupCleanup(args: {
  worktreeId: string
  groupId: string
  ownsGroupCleanup: boolean
}): boolean {
  if (!args.ownsGroupCleanup) {
    return false
  }
  const worktreeMarker = `\0${args.worktreeId}\0`
  let transferred = false
  for (const [key, placement] of placementByPendingPage) {
    if (key.includes(worktreeMarker) && placement.groupId === args.groupId) {
      placementByPendingPage.set(key, { ...placement, ownsGroupCleanup: true })
      transferred = true
    }
  }
  return !transferred
}

export function clearWebSessionBrowserPlacementsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const prefix = worktreePrefix(environmentId, worktreeId)
  for (const key of placementByPendingPage.keys()) {
    if (key.startsWith(prefix)) {
      placementByPendingPage.delete(key)
    }
  }
}

export function clearWebSessionBrowserPlacementsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of placementByPendingPage.keys()) {
    if (key.startsWith(prefix)) {
      placementByPendingPage.delete(key)
    }
  }
}

export function resetWebSessionBrowserPlacementsForTests(): void {
  placementByPendingPage.clear()
}
