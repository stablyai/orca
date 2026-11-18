// Which Needs you rows show: approvals first and never hidden, then the first five, then a footer.
export const NEEDS_YOU_CAP = 5

export type NeedsYouFold<Row> = {
  /** Every row, approvals first, else in the order given. */
  ordered: Row[]
  /** Keys of the rows shown, in order. */
  visible: string[]
  /** Rows behind the footer; 0 shows no footer. */
  hidden: number
  /** More rows than the cap would hide, so a footer can fold them, open or not. */
  folds: boolean
}

export function needsYouFold<Row extends { key: string; approval: boolean }>(
  rows: readonly Row[],
  {
    expanded,
    focusedKey,
    showAll = false
  }: {
    expanded: boolean
    focusedKey: string | null
    /** Every row, with no footer: offline, the footer is off with the rest of the panel. */
    showAll?: boolean
  }
): NeedsYouFold<Row> {
  const approvals = rows.filter((row) => row.approval)
  const ordered = [...approvals, ...rows.filter((row) => !row.approval)]
  const shown = Math.max(NEEDS_YOU_CAP, approvals.length)
  // One hidden row isn't worth a footer.
  const folds = !showAll && ordered.length - shown >= 2
  // A row holding keyboard focus stays, so a row sorting above it never hides the control in use.
  const visible = ordered
    .filter((row, index) => !folds || expanded || index < shown || row.key === focusedKey)
    .map((row) => row.key)
  return { ordered, visible, hidden: ordered.length - visible.length, folds }
}
