const TABBABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

function tabbables(sheet: HTMLElement): HTMLElement[] {
  return Array.from(sheet.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => element.checkVisibility() && element.closest('[inert]') === null
  )
}

/** Tab and Shift+Tab wrap inside the sheet; the rest of the window stays reachable by pointer.
 *  Takes the sheet itself: a portaled prompt card's keys reach it through the card's own React parents. */
export function trapNativeChatSubagentSheetTab(
  event: React.KeyboardEvent,
  sheet: HTMLElement
): void {
  if (
    event.key !== 'Tab' ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(event.target instanceof Node) ||
    !sheet.contains(event.target)
  ) {
    return
  }
  const items = tabbables(sheet)
  const active = document.activeElement
  const first = items[0]
  const last = items.at(-1)
  const wrapTo =
    !first || !last
      ? sheet
      : event.shiftKey
        ? active === first || active === sheet
          ? last
          : null
        : active === last
          ? first
          : null
  if (wrapTo) {
    event.preventDefault()
    wrapTo.focus()
  }
}
