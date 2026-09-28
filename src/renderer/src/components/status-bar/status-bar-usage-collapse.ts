export type UsageChipMeasure = {
  provider: string
  width: number
  urgent: boolean
  collapsed: boolean
}

export type UsageRowMeasure = {
  /** Width of the usage row as if every chip were shown, so collapsing never reads as a content change. */
  naturalWidth: number
  /** Width the row actually occupies right now. */
  renderedWidth: number
  chips: UsageChipMeasure[]
  moreChipWidth: number
  chipGap: number
}

/**
 * Chooses which usage chips give way so the row sheds `overflowPx`. Calm agents go first,
 * from the end of the roster; urgent ones only when calm ones can't free enough room.
 */
export function pickCollapsedUsageChips(
  chips: readonly Pick<UsageChipMeasure, 'provider' | 'width' | 'urgent'>[],
  overflowPx: number,
  moreChipWidth: number,
  chipGap: number
): string[] {
  if (overflowPx <= 0) {
    return []
  }
  // The first collapsed chip brings the "+N" chip (and its gap) into the row.
  const needed = overflowPx + moreChipWidth + chipGap
  const dropOrder = [
    ...chips.filter((chip) => !chip.urgent).toReversed(),
    ...chips.filter((chip) => chip.urgent).toReversed()
  ]
  const collapsed: string[] = []
  let freed = 0
  for (const chip of dropOrder) {
    if (freed >= needed) {
      break
    }
    collapsed.push(chip.provider)
    freed += chip.width + chipGap
  }
  return collapsed
}

/** Reads the `data-usage-*` markers the status bar renders on its usage chips and "+N" chip. */
export function measureUsageRow(usage: HTMLElement | null): UsageRowMeasure {
  if (!usage) {
    return { naturalWidth: 0, renderedWidth: 0, chips: [], moreChipWidth: 0, chipGap: 0 }
  }
  const renderedWidth = usage.getBoundingClientRect().width
  const chipElements = [...usage.querySelectorAll<HTMLElement>('[data-usage-chip]')]
  const chipRow = chipElements[0]?.parentElement
  const chipGap = chipRow ? Number.parseFloat(getComputedStyle(chipRow).columnGap) || 0 : 0
  const chips = chipElements.map((element) => ({
    provider: element.dataset.usageChip ?? '',
    width: element.getBoundingClientRect().width,
    urgent: element.dataset.usageUrgent === 'true',
    collapsed: element.dataset.usageCollapsed === 'true'
  }))
  const more = usage.querySelector<HTMLElement>('[data-usage-more]')
  const moreChipWidth = more?.getBoundingClientRect().width ?? 0
  const moreInRow = more !== null && more.dataset.usageCollapsed !== 'true'
  const collapsedWidth = chips
    .filter((chip) => chip.collapsed)
    .reduce((sum, chip) => sum + chip.width + chipGap, 0)
  return {
    naturalWidth: renderedWidth + collapsedWidth - (moreInRow ? moreChipWidth + chipGap : 0),
    renderedWidth,
    chips,
    moreChipWidth,
    chipGap
  }
}
