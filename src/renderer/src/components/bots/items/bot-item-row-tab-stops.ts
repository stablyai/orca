// Where Tab stops inside an item row, for a long group that moves Tab on to the next row.
/** The row's controls Tab stops at, in order: shown, enabled, and in the Tab order. */
export function rowTabStops(row: HTMLElement): HTMLElement[] {
  return [
    ...row.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')
  ].filter(
    (control) =>
      control.tabIndex >= 0 &&
      !control.matches(':disabled') &&
      control.getClientRects().length > 0 &&
      getComputedStyle(control).visibility !== 'hidden'
  )
}
