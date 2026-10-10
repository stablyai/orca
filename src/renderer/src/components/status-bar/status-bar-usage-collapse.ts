export type UsageChipMeasure = {
  provider: string
  width: number
  urgent: boolean
  /** The chip renders a percentage, so the leading unit label covers it. */
  percentage: boolean
  collapsed: boolean
}

export type UsageRowMeasure = {
  /** Width of the usage row as if every chip were shown, so collapsing never reads as a content change. */
  naturalWidth: number
  /** Width with every calm chip collapsed into "+N", keeping urgent ones. */
  pinnedWidth: number
  /** Width the row actually occupies right now. */
  renderedWidth: number
  chips: UsageChipMeasure[]
  moreChipWidth: number
  chipGap: number
  unitLabelWidth: number
}

/**
 * Chooses which usage chips give way so the row sheds `overflowPx`. Calm agents go first,
 * from the end of the roster; urgent ones only when calm ones can't free enough room.
 */
export function pickCollapsedUsageChips(
  chips: readonly Pick<UsageChipMeasure, 'provider' | 'width' | 'urgent' | 'percentage'>[],
  overflowPx: number,
  moreChipWidth: number,
  chipGap: number,
  unitLabelWidth = 0
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
  let remainingPercentageChips = chips.filter((chip) => chip.percentage).length
  for (const chip of dropOrder) {
    if (freed >= needed) {
      break
    }
    collapsed.push(chip.provider)
    freed += chip.width + chipGap
    if (chip.percentage) {
      remainingPercentageChips -= 1
      if (remainingPercentageChips === 0 && unitLabelWidth > 0) {
        freed += unitLabelWidth + chipGap
      }
    }
  }
  return collapsed
}

/** Reads the `data-usage-*` markers the status bar renders on its usage chips, unit label, and "+N" chip. */
export function measureUsageRow(usage: HTMLElement | null): UsageRowMeasure {
  if (!usage) {
    return {
      naturalWidth: 0,
      pinnedWidth: 0,
      renderedWidth: 0,
      chips: [],
      moreChipWidth: 0,
      chipGap: 0,
      unitLabelWidth: 0
    }
  }
  const renderedWidth = usage.getBoundingClientRect().width
  const chipElements = [...usage.querySelectorAll<HTMLElement>('[data-usage-chip]')]
  const chipRow = chipElements[0]?.parentElement
  const chipGap = chipRow ? Number.parseFloat(getComputedStyle(chipRow).columnGap) || 0 : 0
  const chips = chipElements.map((element) => ({
    provider: element.dataset.usageChip ?? '',
    width: element.getBoundingClientRect().width,
    urgent: element.dataset.usageUrgent === 'true',
    percentage: element.dataset.usagePercentage === 'true',
    collapsed: element.dataset.usageCollapsed === 'true'
  }))
  const more = usage.querySelector<HTMLElement>('[data-usage-more]')
  const moreChipWidth = more?.getBoundingClientRect().width ?? 0
  const moreInRow = more !== null && more.dataset.usageCollapsed !== 'true'
  const collapsedWidth = chips
    .filter((chip) => chip.collapsed)
    .reduce((sum, chip) => sum + chip.width + chipGap, 0)
  // Why: the unit label stays mounted while collapsed, so count it like a collapsed chip.
  const unit = usage.querySelector<HTMLElement>('[data-usage-unit]')
  const unitLabelWidth = unit?.getBoundingClientRect().width ?? 0
  const unitWidth = unit ? unitLabelWidth + chipGap : 0
  const unitCollapsed = unit?.dataset.usageCollapsed === 'true'
  const naturalWidth =
    renderedWidth +
    collapsedWidth -
    (moreInRow ? moreChipWidth + chipGap : 0) +
    (unitCollapsed ? unitWidth : 0)
  const calmChips = chips.filter((chip) => !chip.urgent)
  // Pinned keeps the label only when an urgent chip it labels stays in the row.
  const pinnedUnitWidth = chips.some((chip) => chip.urgent && chip.percentage) ? 0 : unitWidth
  const pinnedWidth =
    naturalWidth -
    calmChips.reduce((sum, chip) => sum + chip.width + chipGap, 0) +
    (calmChips.length > 0 ? moreChipWidth + chipGap : 0) -
    pinnedUnitWidth
  return {
    naturalWidth,
    pinnedWidth,
    renderedWidth,
    chips,
    moreChipWidth,
    chipGap,
    unitLabelWidth
  }
}
