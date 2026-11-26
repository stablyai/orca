/** True when a key event comes from inside the open close-terminal confirmation dialog. */
export function isEventTargetInsideCloseTerminalDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-close-terminal-dialog="true"]') !== null
}
