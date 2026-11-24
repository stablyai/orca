import { createTabGroupScopedState } from '@/lib/workspace/tabs/tab-group-scoped-state'

// A released tab strip keeps its host's answer, as its still-mounted subscription did before release.
// Holds are disposed with their tab group, so they are bounded by open groups.
const holdCountByOwnerKey = new Map<string, number>()

function changeHoldCount(ownerKey: string, delta: number): void {
  const count = (holdCountByOwnerKey.get(ownerKey) ?? 0) + delta
  if (count > 0) {
    holdCountByOwnerKey.set(ownerKey, count)
  } else {
    holdCountByOwnerKey.delete(ownerKey)
  }
}

const heldOwnerKeyByGroup = createTabGroupScopedState<string>((ownerKey) =>
  changeHoldCount(ownerKey, -1)
)

export function holdWindowsTerminalCapabilitiesForReleasedStrip(
  worktreeId: string,
  groupId: string,
  ownerKey: string
): void {
  takeWindowsTerminalCapabilityHold(worktreeId, groupId)
  heldOwnerKeyByGroup.set(worktreeId, groupId, ownerKey)
  if (heldOwnerKeyByGroup.get(worktreeId, groupId) === ownerKey) {
    changeHoldCount(ownerKey, 1)
  }
}

/** True when this strip unmounted with its group open, i.e. its workspace released the layout. */
export function hasWindowsTerminalCapabilityHold(worktreeId: string, groupId: string): boolean {
  return heldOwnerKeyByGroup.get(worktreeId, groupId) !== undefined
}

export function takeWindowsTerminalCapabilityHold(worktreeId: string, groupId: string): void {
  const ownerKey = heldOwnerKeyByGroup.take(worktreeId, groupId)
  if (ownerKey !== undefined) {
    changeHoldCount(ownerKey, -1)
  }
}

export function isWindowsTerminalCapabilityOwnerHeld(ownerKey: string): boolean {
  return holdCountByOwnerKey.has(ownerKey)
}
