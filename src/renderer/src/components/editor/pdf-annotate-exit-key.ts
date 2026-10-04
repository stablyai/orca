/**
 * Whether an Escape press should leave PDF annotate mode. Escape is global and the app marks
 * every press handled, so this runs in capture (before any popup closes) and declines when an
 * open dialog or menu, a text field, or a hidden viewer would make the key mean something else.
 */
export function isAnnotateModeExitKey(event: KeyboardEvent, container: HTMLElement): boolean {
  if (event.key !== 'Escape' || container.clientHeight === 0) {
    return false
  }
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
    return false
  }
  return !document.querySelector(
    '[data-radix-popper-content-wrapper] :is([role="dialog"], [role="menu"])'
  )
}
