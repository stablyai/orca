/** The phone's rule for pressing a chat row (the desktop sidebar's chat rows only open; their chevron folds): it opens and unfolds; pressed again while it is the open
 *  one, it folds or unfolds. A double-click's second click does nothing, so it never opens then folds.
 *  A phone, whose chat covers the list, never passes `active`: there a press always opens. */
export function pressFoldableRow(
  row: {
    active: boolean
    folded: boolean
    /** False when it couldn't open. */
    open: () => boolean | void
    /** Null for a row with nothing to fold. */
    toggle: (() => void) | null
  },
  press: { detail: number; repeat?: boolean }
): void {
  // A held key repeats; it must not flicker the fold.
  if (press.detail > 1 || press.repeat) {
    return
  }
  if (row.active && row.toggle) {
    row.toggle()
    return
  }
  if (row.open() !== false && row.folded) {
    row.toggle?.()
  }
}
