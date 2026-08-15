export const detachedHeadAutoDerivedDisplayNames = new Map<string, string>()

export function setDetachedHeadAutoDerivedDisplayNameForTests(
  worktreeId: string,
  displayName: string
): void {
  detachedHeadAutoDerivedDisplayNames.set(worktreeId, displayName)
}

export function getDetachedHeadAutoDerivedDisplayNameForTests(
  worktreeId: string
): string | undefined {
  return detachedHeadAutoDerivedDisplayNames.get(worktreeId)
}

export function forgetDetachedHeadAutoDerivedDisplayName(worktreeId: string): void {
  detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
}
