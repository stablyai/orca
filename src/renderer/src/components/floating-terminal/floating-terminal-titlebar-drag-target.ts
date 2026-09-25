/** Interactive chrome living inside the draggable titlebar. `[data-tab-id]` and the
 *  client-hosted row marker cover every tab kind: a press
 *  on a tab starts a dnd-kit reorder, so it must never also move the panel. */
const FLOATING_TERMINAL_NO_DRAG_SELECTOR =
  'button,input,textarea,select,[role="menuitem"],[data-tab-id],[data-client-hosted-browser-row-id],[data-floating-terminal-no-drag]'

export function isFloatingTerminalDragTarget(target: EventTarget): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return true
  }

  return target.closest(FLOATING_TERMINAL_NO_DRAG_SELECTOR) === null
}
