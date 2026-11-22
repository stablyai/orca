import type { ActiveRightSidebarTab } from '../../../../../shared/ui-chrome/ui-chrome-types'

const TOP_ACTIVITY_BUTTON_WIDTH = 36
const TOP_ACTIVITY_MORE_BUTTON_WIDTH = 32
// A labeled tab: padding, icon, gap and the 2px gap after it; unmeasured, its title is about 7px a character.
const LABELED_TAB_CHROME_WIDTH = 38
const LABELED_TAB_CHAR_WIDTH = 7
const LABELED_TAB_COUNT_WIDTH = 22
// A labeled tab drawn as its icon alone, plus the gap after it.
const LABELED_TAB_COMPACT_WIDTH = 30
// Room for one wide glyph (a W or a CJK character) and an ellipsis, so the open tab's title stays readable.
const LABELED_TAB_MIN_TITLE_WIDTH = 24

type TopActivityItem = {
  id: ActiveRightSidebarTab
  title: string
  labeledTab?: boolean
  count?: number
}

/** A title's drawn width in px, or null where it can't be measured. */
export type MeasureTabTitle = (title: string) => number | null

function estimateTitle(title: string): number {
  return title.length * LABELED_TAB_CHAR_WIDTH
}

/**
 * Once every closed tab is an icon, the open tab is the only one left that can shrink, so any shortfall
 * comes out of its title alone. Hold the strip's padding and a readable title for it, beyond its
 * estimate. While closed tabs still show titles they shrink with it, and the estimate is enough.
 */
function openTitleReserve(
  item: TopActivityItem | undefined,
  stripPadding: number,
  titleWidth: (item: TopActivityItem) => number
) {
  if (!item?.labeledTab) {
    return 0
  }
  return stripPadding + Math.max(0, LABELED_TAB_MIN_TITLE_WIDTH - titleWidth(item))
}

export type TopActivityBarLayout<T> = {
  visibleItems: T[]
  overflowItems: T[]
  /** Labeled tabs drawn as their icon alone. */
  compactIds: ReadonlySet<ActiveRightSidebarTab>
}

/**
 * Which tabs fit beside the panel toggle. Labeled tabs keep every title while all of them fit; else
 * only the open tab keeps its title and the rest are icons. Tabs that still don't fit go under More;
 * the open tab always stays in the bar. `availableWidth` is the strip's border box; `stripPadding`
 * is its horizontal padding; `measureTitle` measures titles in the tab's font (estimated without it).
 */
export function getTopActivityBarLayout<T extends TopActivityItem>(
  items: readonly T[],
  availableWidth: number | null,
  activeId: ActiveRightSidebarTab,
  stripPadding = 0,
  measureTitle: MeasureTabTitle = () => null
): TopActivityBarLayout<T> {
  const titleWidth = (item: TopActivityItem): number =>
    measureTitle(item.title) ?? estimateTitle(item.title)
  const buttonWidth = (item: TopActivityItem, compact: boolean): number => {
    if (!item.labeledTab) {
      return TOP_ACTIVITY_BUTTON_WIDTH
    }
    if (compact) {
      return LABELED_TAB_COMPACT_WIDTH
    }
    return LABELED_TAB_CHROME_WIDTH + titleWidth(item) + (item.count ? LABELED_TAB_COUNT_WIDTH : 0)
  }
  const compactIds = new Set<ActiveRightSidebarTab>()
  if (!availableWidth || !Number.isFinite(availableWidth)) {
    return { visibleItems: [...items], overflowItems: [], compactIds }
  }
  let totalWidth = items.reduce((total, item) => total + buttonWidth(item, false), 0)
  if (totalWidth + stripPadding <= availableWidth) {
    return { visibleItems: [...items], overflowItems: [], compactIds }
  }
  const activeItem = items.find((item) => item.id === activeId)
  const reserve = openTitleReserve(activeItem, stripPadding, titleWidth)
  for (const item of items) {
    if (item.labeledTab && item.id !== activeId) {
      compactIds.add(item.id)
      totalWidth += buttonWidth(item, true) - buttonWidth(item, false)
    }
  }
  if (compactIds.size > 0 && totalWidth + reserve <= availableWidth) {
    return { visibleItems: [...items], overflowItems: [], compactIds }
  }

  // Hold room for More and the open tab before filling the rest in order, so pinning a titled open
  // tab can't push the bar past its width, or squeeze its title to nothing.
  const fittedWidth = (item: T): number => buttonWidth(item, compactIds.has(item.id))
  const visibleIds = new Set<ActiveRightSidebarTab>()
  let used = TOP_ACTIVITY_MORE_BUTTON_WIDTH
  if (activeItem) {
    visibleIds.add(activeItem.id)
    used += fittedWidth(activeItem) + reserve
  }
  for (const item of items) {
    if (item.id === activeId) {
      continue
    }
    used += fittedWidth(item)
    if (used > availableWidth) {
      break
    }
    visibleIds.add(item.id)
  }
  if (visibleIds.size === 0 && items.length > 0) {
    visibleIds.add(items[0].id)
  }

  return {
    visibleItems: items.filter((item) => visibleIds.has(item.id)),
    overflowItems: items.filter((item) => !visibleIds.has(item.id)),
    compactIds
  }
}
