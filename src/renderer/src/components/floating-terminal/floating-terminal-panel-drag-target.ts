const FLOATING_TERMINAL_NO_DRAG_SELECTOR =
  'button,input,textarea,select,[role="menuitem"],[data-testid="sortable-tab"],[data-floating-terminal-no-drag]'

export function isFloatingTerminalDragTarget(target: EventTarget): boolean {
  return !(target instanceof HTMLElement && target.closest(FLOATING_TERMINAL_NO_DRAG_SELECTOR))
}
