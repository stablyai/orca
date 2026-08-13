type PendingBrowserPlacement = {
  groupId: string
  ownsGroupCleanup: boolean
}

const placementByPendingPage = new Map<string, PendingBrowserPlacement>()
const materializedGroupKeys = new Set<string>()
const pendingCleanupClaimsByGroup = new Map<string, number>()
const MAX_PENDING_PLACEMENTS = 128

function pageKey(environmentId: string, worktreeId: string, remotePageId: string): string {
  return `${environmentId}\0${worktreeId}\0${remotePageId}`
}

function worktreePrefix(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}\0`
}

function worktreeGroupKey(worktreeId: string, groupId: string): string {
  return `${worktreeId}\0${groupId}`
}

function hasPlacementForGroup(worktreeId: string, groupId: string): boolean {
  const worktreeMarker = `\0${worktreeId}\0`
  for (const [key, placement] of placementByPendingPage) {
    if (key.includes(worktreeMarker) && placement.groupId === groupId) {
      return true
    }
  }
  return false
}

function forgetSettledMaterializedGroup(worktreeId: string, groupId: string): void {
  const key = worktreeGroupKey(worktreeId, groupId)
  if (!hasPlacementForGroup(worktreeId, groupId) && !pendingCleanupClaimsByGroup.has(key)) {
    materializedGroupKeys.delete(key)
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
  const key = pageKey(args.environmentId, args.worktreeId, args.remotePageId)
  const placement = placementByPendingPage.get(key)
  placementByPendingPage.delete(key)
  if (placement) {
    forgetSettledMaterializedGroup(args.worktreeId, placement.groupId)
  }
}

export function takeWebSessionBrowserPlacementGroup(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
}): string | undefined {
  const key = pageKey(args.environmentId, args.worktreeId, args.remotePageId)
  const placement = placementByPendingPage.get(key)
  placementByPendingPage.delete(key)
  if (placement) {
    forgetSettledMaterializedGroup(args.worktreeId, placement.groupId)
  }
  return placement?.groupId
}

export function peekWebSessionBrowserPlacementGroup(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
}): string | undefined {
  return placementByPendingPage.get(pageKey(args.environmentId, args.worktreeId, args.remotePageId))
    ?.groupId
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
  groupId: string
  callerCreatedGroup: boolean
}): boolean {
  const key = pageKey(args.environmentId, args.worktreeId, args.remotePageId)
  const placement = placementByPendingPage.get(key)
  const groupId = placement?.groupId ?? args.groupId
  const groupKey = worktreeGroupKey(args.worktreeId, groupId)
  const materialized = materializedGroupKeys.has(groupKey)
  placementByPendingPage.delete(key)
  const ownsCleanup =
    !materialized && (args.callerCreatedGroup || placement?.ownsGroupCleanup === true)
  if (ownsCleanup) {
    pendingCleanupClaimsByGroup.set(groupKey, (pendingCleanupClaimsByGroup.get(groupKey) ?? 0) + 1)
  }
  forgetSettledMaterializedGroup(args.worktreeId, groupId)
  return ownsCleanup
}

export function markWebSessionBrowserPlacementGroupMaterialized(args: {
  worktreeId: string
  groupId: string
}): void {
  if (hasPlacementForGroup(args.worktreeId, args.groupId)) {
    materializedGroupKeys.add(worktreeGroupKey(args.worktreeId, args.groupId))
  }
}

export function claimWebSessionBrowserPlacementGroupCleanup(args: {
  worktreeId: string
  groupId: string
  ownsGroupCleanup: boolean
}): boolean {
  if (!args.ownsGroupCleanup) {
    return false
  }
  const groupKey = worktreeGroupKey(args.worktreeId, args.groupId)
  const pendingClaims = pendingCleanupClaimsByGroup.get(groupKey) ?? 0
  if (pendingClaims <= 1) {
    pendingCleanupClaimsByGroup.delete(groupKey)
  } else {
    pendingCleanupClaimsByGroup.set(groupKey, pendingClaims - 1)
  }
  if (materializedGroupKeys.has(groupKey)) {
    forgetSettledMaterializedGroup(args.worktreeId, args.groupId)
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
    if (key.startsWith(prefix) && !placementByPendingPage.get(key)?.ownsGroupCleanup) {
      placementByPendingPage.delete(key)
    }
  }
}

export function clearWebSessionBrowserPlacementsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of placementByPendingPage.keys()) {
    if (key.startsWith(prefix) && !placementByPendingPage.get(key)?.ownsGroupCleanup) {
      placementByPendingPage.delete(key)
    }
  }
}

export function resetWebSessionBrowserPlacementsForTests(): void {
  placementByPendingPage.clear()
  materializedGroupKeys.clear()
  pendingCleanupClaimsByGroup.clear()
}
