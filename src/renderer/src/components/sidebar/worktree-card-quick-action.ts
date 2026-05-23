export type WorktreeCardQuickActionKind = 'sleep' | 'delete' | null

export function getWorkspaceQuickActionKind({
  hasActiveActivity,
  isDeletable,
  isInactive,
  isMacOptionPressed
}: {
  hasActiveActivity: boolean
  isDeletable: boolean
  isInactive: boolean
  isMacOptionPressed: boolean
}): WorktreeCardQuickActionKind {
  if (isInactive) {
    return isDeletable ? 'delete' : null
  }
  if (hasActiveActivity) {
    return isMacOptionPressed && isDeletable ? 'delete' : 'sleep'
  }
  return null
}
