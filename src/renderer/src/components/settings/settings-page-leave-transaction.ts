export type SettingsPageLeaveTransaction = {
  appearanceDirty: boolean
  sourceControlDirty: boolean
  confirmAppearanceLeave: (options: { discardDraftOnLeave: false }) => Promise<boolean>
  confirmSourceControlDiscard: () => Promise<boolean>
  discardAppearanceDraft: () => void
  discardSourceControlDrafts: () => void
}

export type SettingsWindowCloseGuard = {
  intentionalRestart: boolean
  sourceControlDirty: boolean
  confirmAppearanceLeave: (options: { discardDraftOnLeave: false }) => Promise<boolean>
  confirmSourceControlDiscard: () => Promise<boolean>
}

export async function runSettingsWindowCloseGuard({
  intentionalRestart,
  sourceControlDirty,
  confirmAppearanceLeave,
  confirmSourceControlDiscard
}: SettingsWindowCloseGuard): Promise<boolean> {
  if (intentionalRestart) {
    return true
  }
  if (sourceControlDirty && !(await confirmSourceControlDiscard())) {
    return false
  }
  return confirmAppearanceLeave({ discardDraftOnLeave: false })
}

export async function runSettingsPageLeaveTransaction({
  appearanceDirty,
  sourceControlDirty,
  confirmAppearanceLeave,
  confirmSourceControlDiscard,
  discardAppearanceDraft,
  discardSourceControlDrafts
}: SettingsPageLeaveTransaction): Promise<boolean> {
  if (appearanceDirty && !(await confirmAppearanceLeave({ discardDraftOnLeave: false }))) {
    return false
  }
  if (sourceControlDirty && !(await confirmSourceControlDiscard())) {
    return false
  }
  if (appearanceDirty) {
    discardAppearanceDraft()
  }
  if (sourceControlDirty) {
    discardSourceControlDrafts()
  }
  return true
}
