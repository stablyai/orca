// Where Tab stops inside an item row, for a long group that moves Tab on to the next row.
import type { BotItem } from '../../../../../shared/bots/bot-items'

/** Which end of a row focus enters at: Tab forward lands on its first control, Shift+Tab on its last. */
export type BotItemRowEdge = 'first' | 'last'

/** The row's controls Tab stops at, in order: shown and enabled; `inOrder` also in the Tab order now (a
 *  row out of the long group's Tab order has every control out of it). */
export function rowTabStops(row: HTMLElement, inOrder = true): HTMLElement[] {
  return [
    ...row.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')
  ].filter(
    (control) =>
      (inOrder ? control.tabIndex >= 0 : control.tabIndex >= -1) &&
      // Hidden form mirrors (a checkbox's native input) are never Tab stops.
      !control.closest('[aria-hidden="true"]') &&
      !control.matches(':disabled') &&
      control.getClientRects().length > 0 &&
      getComputedStyle(control).visibility !== 'hidden'
  )
}

/** The control a row takes focus on: the row itself while its controls are off, else the end Tab came
 *  in from, else its title. */
export function rowFocusControl(
  row: HTMLElement,
  edge: BotItemRowEdge | undefined,
  disabled: boolean
): HTMLElement | null {
  if (disabled) {
    return row
  }
  const title = row.querySelector<HTMLElement>('[data-bot-item-open]')
  if (!edge) {
    return title
  }
  const controls = rowTabStops(row, false)
  return (edge === 'first' ? controls[0] : controls.at(-1)) ?? title
}

/** Tab or Shift+Tab, with no other modifier and not already handled. */
export function plainTab(event: React.KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === 'Tab' &&
    !event.defaultPrevented &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  )
}

/** The row Tab goes on to: from a row's last control the next row, and with Shift from its first the one
 *  before (drawn, then focused at the end Tab came in from), so moving by Tab reaches every row as in a
 *  plain list. Null leaves Tab to the browser. */
export function rowTabTarget(
  event: React.KeyboardEvent<HTMLElement>,
  items: readonly BotItem[]
): { uid: string; at: number; edge: BotItemRowEdge } | null {
  const row =
    event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-bot-item-index]')
      : null
  if (!row || !event.currentTarget.contains(row)) {
    return null
  }
  const at = Number(row.dataset.botItemIndex) + (event.shiftKey ? -1 : 1)
  const controls = rowTabStops(row)
  const item = items[at]
  if ((event.shiftKey ? controls[0] : controls.at(-1)) !== event.target || !item) {
    return null
  }
  return { uid: item.uid, at, edge: event.shiftKey ? 'last' : 'first' }
}

/** Where focus went as it left a long group's grid: still inside; elsewhere on the page, or to nothing
 *  from a row's menu (closed by the pointer) while Orca keeps focus, so Tab back in enters at the first
 *  row as in a plain list; or anywhere else (Orca in the background, a click inside the group). */
export function groupFocusLeft(event: React.FocusEvent<HTMLElement>): 'within' | 'page' | 'kept' {
  const to = event.relatedTarget
  if (to instanceof Node && event.currentTarget.contains(to)) {
    return 'within'
  }
  const fromMenu = !event.currentTarget.contains(event.target) && document.hasFocus()
  return to !== null || fromMenu ? 'page' : 'kept'
}

/** The row the end-of-group entry hands focus to: Shift+Tab from below enters the last row at its end;
 *  Tab from nothing (after a click inside the group) goes on from the group's Tab stop row. */
export function endEntryTarget(
  event: React.FocusEvent<HTMLElement>,
  items: readonly BotItem[],
  tabStop: number
): { uid: string; at: number; edge: BotItemRowEdge } {
  const fromNothing = event.relatedTarget === null
  const at = fromNothing ? tabStop : items.length - 1
  return { uid: items[at]!.uid, at, edge: fromNothing ? 'first' : 'last' }
}

/** Back's row: focused (its title, or the row itself while its controls are off) and scrolled to. Back
 *  is a command, not navigation: Esc would otherwise draw Chromium's keyboard ring here. */
export function focusBotItemBackRow(row: HTMLElement | null | undefined, onRow = false): void {
  const control = onRow ? row : row?.querySelector<HTMLElement>('[data-bot-item-open]')
  control?.focus({ preventScroll: true, focusVisible: false })
  row?.scrollIntoView({ block: 'nearest' })
}
