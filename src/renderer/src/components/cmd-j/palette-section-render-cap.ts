/** Bound per-keystroke DOM work while preserving ranking; expansion and query refinement expose the remaining matches. */
export const PALETTE_SECTION_RENDER_CAP = 50

/** Number of additional entries to reveal per section on each "See more" click. */
export const PALETTE_SECTION_EXPAND_STEP = 20

/** Preview the leading primary section, then show a trailing-section floor so both stay above the fold. */
export const TYPED_QUERY_LEADING_PREVIEW = 6

/** Min rows for the non-leading primary section (tabs ↔ worktrees) in the first screen. */
export const TYPED_QUERY_TRAILING_FLOOR = 3

export type CappedPaletteSection<T> = {
  visible: readonly T[]
  overflowCount: number
}

export function capPaletteSection<T>(
  items: readonly T[],
  cap: number = PALETTE_SECTION_RENDER_CAP,
  retain?: (item: T) => boolean
): CappedPaletteSection<T> {
  if (!Number.isFinite(cap) || cap < 0 || items.length <= cap) {
    return { visible: items, overflowCount: 0 }
  }
  const visible = items.slice(0, cap)
  // Keep the selected match visible after reranking without increasing the DOM row cap.
  let retained: T | undefined
  if (retain) {
    for (let index = cap; index < items.length; index += 1) {
      if (retain(items[index])) {
        retained = items[index]
        break
      }
    }
  }
  if (retained !== undefined && cap > 0) {
    visible.splice(cap - 1, 1, retained)
  }
  return { visible, overflowCount: items.length - visible.length }
}

/** moreCount includes both scrollable remainder and hard-cap overflow, served by one preview hint. */
type SoftSplitSection<T> = {
  preview: readonly T[]
  rest: readonly T[]
  moreCount: number
}

function softSplitPaletteSection<T>(
  items: readonly T[],
  previewCount: number,
  hardCap: number = PALETTE_SECTION_RENDER_CAP,
  retain?: (item: T) => boolean
): SoftSplitSection<T> {
  const capped = capPaletteSection(items, hardCap, retain)
  const previewSize = Math.max(0, Math.min(previewCount, capped.visible.length))
  return {
    preview: capped.visible.slice(0, previewSize),
    rest: capped.visible.slice(previewSize),
    moreCount: Math.max(0, items.length - previewSize)
  }
}

/** Interleave primary previews before their capped remainders; repeat headers on re-entry. Soft counts include rest plus overflow; final hints count only hard overflow. */
export type MultiPrimarySectionLayout<T> = {
  leadingPreview: readonly T[]
  leadingRest: readonly T[]
  leadingMoreCount: number
  leadingHardOverflowCount: number
  trailingFloor: readonly T[]
  trailingRest: readonly T[]
  trailingMoreCount: number
  trailingHardOverflowCount: number
}

export function layoutMultiPrimaryPaletteSections<T>({
  leadingItems,
  trailingItems,
  leadingPreviewCount = TYPED_QUERY_LEADING_PREVIEW,
  trailingFloorCount = TYPED_QUERY_TRAILING_FLOOR,
  hardCap,
  leadingHardCap = hardCap ?? PALETTE_SECTION_RENDER_CAP,
  trailingHardCap = hardCap ?? PALETTE_SECTION_RENDER_CAP,
  leadingRetain,
  trailingRetain
}: {
  leadingItems: readonly T[]
  trailingItems: readonly T[]
  leadingPreviewCount?: number
  trailingFloorCount?: number
  hardCap?: number
  leadingHardCap?: number
  trailingHardCap?: number
  leadingRetain?: (item: T) => boolean
  trailingRetain?: (item: T) => boolean
}): MultiPrimarySectionLayout<T> {
  const leading = softSplitPaletteSection(
    leadingItems,
    leadingPreviewCount,
    leadingHardCap,
    leadingRetain
  )
  const trailing = softSplitPaletteSection(
    trailingItems,
    trailingFloorCount,
    trailingHardCap,
    trailingRetain
  )
  return {
    leadingPreview: leading.preview,
    leadingRest: leading.rest,
    leadingMoreCount: leading.moreCount,
    leadingHardOverflowCount: Math.max(0, leading.moreCount - leading.rest.length),
    trailingFloor: trailing.preview,
    trailingRest: trailing.rest,
    trailingMoreCount: trailing.moreCount,
    // Rendered trailing rows are already visible; the final hint counts only hard-cap overflow.
    trailingHardOverflowCount: Math.max(0, trailing.moreCount - trailing.rest.length)
  }
}

/** Selection/render order for the two interleaved primary sections. */
export function orderMultiPrimaryPaletteItems<T>(
  layout: MultiPrimarySectionLayout<T>
): readonly T[] {
  return [
    ...layout.leadingPreview,
    ...layout.trailingFloor,
    ...layout.leadingRest,
    ...layout.trailingRest
  ]
}
