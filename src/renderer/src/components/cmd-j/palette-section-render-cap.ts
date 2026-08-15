/**
 * Typed queries used to render every match as a DOM row — a one-character query
 * against a few hundred workspaces built hundreds of `CommandItem`s (each with
 * status dots, badges and highlight spans) on every keystroke. Capping the
 * rendered slice bounds worst-case DOM without changing ranking: the top matches
 * are already the ones the user wants, and the overflow hint points at the two
 * ways to reach the rest.
 */
export const PALETTE_SECTION_RENDER_CAP = 50

/**
 * First-screen soft split for typed queries when open tabs and worktrees both
 * match. Leading section shows this many rows, then a non-selectable hint, then
 * the trailing section floor so worktrees (or tabs) stay above the fold.
 */
export const TYPED_QUERY_LEADING_PREVIEW = 6

/** Min rows for the non-leading primary section (tabs ↔ worktrees) in the first screen. */
export const TYPED_QUERY_TRAILING_FLOOR = 3

export type CappedPaletteSection<T> = {
  visible: readonly T[]
  overflowCount: number
}

export function capPaletteSection<T>(
  items: readonly T[],
  cap: number = PALETTE_SECTION_RENDER_CAP
): CappedPaletteSection<T> {
  if (!Number.isFinite(cap) || cap < 0 || items.length <= cap) {
    return { visible: items, overflowCount: 0 }
  }
  return { visible: items.slice(0, cap), overflowCount: items.length - cap }
}

/**
 * Soft-split a hard-capped section into first-screen preview + remainder.
 * `moreCount` is everything after the preview (including rows past the hard cap)
 * so one overflow hint covers both scrollable rest and “keep typing” remainder.
 */
export type SoftSplitSection<T> = {
  preview: readonly T[]
  rest: readonly T[]
  moreCount: number
}

export function softSplitPaletteSection<T>(
  items: readonly T[],
  previewCount: number,
  hardCap: number = PALETTE_SECTION_RENDER_CAP
): SoftSplitSection<T> {
  const capped = capPaletteSection(items, hardCap)
  const previewSize = Math.max(0, Math.min(previewCount, capped.visible.length))
  return {
    preview: capped.visible.slice(0, previewSize),
    rest: capped.visible.slice(previewSize),
    moreCount: Math.max(0, items.length - previewSize)
  }
}

/**
 * Layout when a typed query hits both open tabs and worktrees.
 * Leading section gets a soft preview; trailing primary gets an early floor so
 * it is not buried under ~50 leading rows. Remaining rows of both sections
 * follow (still under the hard cap). Projects/middle stay after both primaries.
 *
 * Callers must re-emit the section header before each remainder — the interleave
 * puts `leadingRest` after the trailing header, so unlabelled rows read as the
 * wrong section.
 *
 * `leadingMoreCount` is the mid-list soft hint (rest resuming below + hard-cap
 * overflow).
 * `trailingHardOverflowCount` is only rows past the hard cap — trailing rest is
 * already rendered, so a soft “more” would double-count scrollable rows.
 */
export type MultiPrimarySectionLayout<T> = {
  leadingPreview: readonly T[]
  leadingRest: readonly T[]
  leadingMoreCount: number
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
  hardCap = PALETTE_SECTION_RENDER_CAP
}: {
  leadingItems: readonly T[]
  trailingItems: readonly T[]
  leadingPreviewCount?: number
  trailingFloorCount?: number
  hardCap?: number
}): MultiPrimarySectionLayout<T> {
  const leading = softSplitPaletteSection(leadingItems, leadingPreviewCount, hardCap)
  const trailing = softSplitPaletteSection(trailingItems, trailingFloorCount, hardCap)
  return {
    leadingPreview: leading.preview,
    leadingRest: leading.rest,
    leadingMoreCount: leading.moreCount,
    trailingFloor: trailing.preview,
    trailingRest: trailing.rest,
    trailingMoreCount: trailing.moreCount,
    // Why: floor + rest already cover every rendered trailing row; only the
    // hard-capped tail needs a “keep typing” hint after the section.
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
