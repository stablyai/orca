/** Column template for the artifacts list table; shared chrome lives in @/lib/list-table-layout. */
// Name | Type | Size | Updated | Expires | Actions
export const ARTIFACTS_TABLE_GRID_CLASS =
  'grid grid-cols-[minmax(0,1.6fr)_minmax(4.5rem,6.5rem)_minmax(4rem,5.5rem)_minmax(6.5rem,9rem)_minmax(6.5rem,9rem)_2.5rem]'

// Why: an `items-center px-3 py-3 text-sm` row whose tallest cell is the `size-7` actions button
// (24px padding + 28px button), plus its own 1px divider. measureElement still corrects, but a
// wrong estimate makes the virtualized list's scrollbar jump on first paint.
export const ARTIFACTS_TABLE_ROW_HEIGHT_PX = 53
