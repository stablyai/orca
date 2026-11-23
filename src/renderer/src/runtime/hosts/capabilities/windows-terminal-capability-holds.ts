// A released tab strip keeps its host's answer, as its still-mounted subscription did before release.
// Holds are bounded by live groups: each add drops its workspace's closed groups and checks one other workspace.
const heldOwnerKeyByGroupIdByWorktree = new Map<string, Map<string, string>>()
const holdCountByOwnerKey = new Map<string, number>()

type GroupOpen = (worktreeId: string, groupId: string) => boolean

function changeHoldCount(ownerKey: string, delta: number): void {
  const count = (holdCountByOwnerKey.get(ownerKey) ?? 0) + delta
  if (count > 0) {
    holdCountByOwnerKey.set(ownerKey, count)
  } else {
    holdCountByOwnerKey.delete(ownerKey)
  }
}

function dropClosedGroups(worktreeId: string, isGroupOpen: GroupOpen): void {
  const held = heldOwnerKeyByGroupIdByWorktree.get(worktreeId)
  if (!held) {
    return
  }
  for (const [groupId, ownerKey] of held) {
    if (!isGroupOpen(worktreeId, groupId)) {
      held.delete(groupId)
      changeHoldCount(ownerKey, -1)
    }
  }
  if (held.size === 0) {
    heldOwnerKeyByGroupIdByWorktree.delete(worktreeId)
  }
}

export function holdWindowsTerminalCapabilitiesForReleasedStrip(
  worktreeId: string,
  groupId: string,
  ownerKey: string,
  isGroupOpen: GroupOpen
): void {
  takeWindowsTerminalCapabilityHold(worktreeId, groupId)
  dropClosedGroups(worktreeId, isGroupOpen)
  // Rotate one other workspace through the check so holds of deleted workspaces drain too.
  const oldest = heldOwnerKeyByGroupIdByWorktree.keys().next()
  if (!oldest.done && oldest.value !== worktreeId) {
    const other = heldOwnerKeyByGroupIdByWorktree.get(oldest.value)
    heldOwnerKeyByGroupIdByWorktree.delete(oldest.value)
    if (other) {
      heldOwnerKeyByGroupIdByWorktree.set(oldest.value, other)
    }
    dropClosedGroups(oldest.value, isGroupOpen)
  }
  const held = heldOwnerKeyByGroupIdByWorktree.get(worktreeId) ?? new Map<string, string>()
  held.set(groupId, ownerKey)
  heldOwnerKeyByGroupIdByWorktree.set(worktreeId, held)
  changeHoldCount(ownerKey, 1)
}

/** True when this strip unmounted with its group open, i.e. its workspace released the layout. */
export function hasWindowsTerminalCapabilityHold(worktreeId: string, groupId: string): boolean {
  return heldOwnerKeyByGroupIdByWorktree.get(worktreeId)?.has(groupId) ?? false
}

export function takeWindowsTerminalCapabilityHold(worktreeId: string, groupId: string): void {
  const held = heldOwnerKeyByGroupIdByWorktree.get(worktreeId)
  const ownerKey = held?.get(groupId)
  if (!held || ownerKey === undefined) {
    return
  }
  held.delete(groupId)
  if (held.size === 0) {
    heldOwnerKeyByGroupIdByWorktree.delete(worktreeId)
  }
  changeHoldCount(ownerKey, -1)
}

export function isWindowsTerminalCapabilityOwnerHeld(ownerKey: string): boolean {
  return holdCountByOwnerKey.has(ownerKey)
}
