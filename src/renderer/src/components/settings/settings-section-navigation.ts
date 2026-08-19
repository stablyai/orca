type SettingsNavEntry = {
  id: string
}

type DirtySettingsSections = {
  appearance: boolean
  sourceControl: boolean
}

type SettingsSectionLeaveConfirmations = {
  appearance: () => Promise<boolean>
  sourceControl: () => Promise<boolean>
}

type AppearanceSectionLeave = {
  dirty: boolean
  confirmLeave: (options: { discardDraftOnLeave: false }) => Promise<boolean>
  discardDraft: () => void
}

export function pinDirtySettingsNavSections<T extends SettingsNavEntry>(
  rankedSections: readonly T[],
  sectionById: ReadonlyMap<string, T>,
  dirtySections: DirtySettingsSections
): T[] {
  const pinnedIds = [
    dirtySections.sourceControl ? 'git' : null,
    dirtySections.appearance ? 'appearance' : null
  ].filter((id): id is string => id !== null)
  const visibleIds = new Set(rankedSections.map((section) => section.id))
  const pinnedSections = pinnedIds.flatMap((id) => {
    const section = sectionById.get(id)
    return section && !visibleIds.has(id) ? [section] : []
  })
  return pinnedSections.length > 0 ? [...rankedSections, ...pinnedSections] : [...rankedSections]
}

export async function settleAppearanceSettingsSectionBeforeLeave({
  dirty,
  confirmLeave,
  discardDraft
}: AppearanceSectionLeave): Promise<boolean> {
  if (!dirty) {
    return true
  }
  if (!(await confirmLeave({ discardDraftOnLeave: false }))) {
    return false
  }
  discardDraft()
  return true
}

export function runSettingsSectionLeaveConfirmation(
  sectionId: string,
  confirmations: SettingsSectionLeaveConfirmations
): Promise<boolean> {
  return sectionId === 'appearance' ? confirmations.appearance() : confirmations.sourceControl()
}

export function releaseSettledSettingsNavGuard(
  guardedSectionId: string | null,
  settledSectionId: string
): string | null {
  return guardedSectionId === settledSectionId ? null : guardedSectionId
}
