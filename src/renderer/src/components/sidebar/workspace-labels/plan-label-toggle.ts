export type LabelToggleTarget = { id: string; labelIds: readonly string[] }

/** Removes the label from every target when all have it; otherwise adds it to the ones missing it. */
export function planLabelToggle<T extends LabelToggleTarget>(
  targets: readonly T[],
  labelId: string
): (T & { labelIds: string[] })[] {
  const allHaveIt = targets.length > 0 && targets.every((t) => t.labelIds.includes(labelId))
  if (allHaveIt) {
    return targets.map((t) => ({ ...t, labelIds: t.labelIds.filter((id) => id !== labelId) }))
  }
  return targets
    .filter((t) => !t.labelIds.includes(labelId))
    .map((t) => ({ ...t, labelIds: [...t.labelIds, labelId] }))
}
