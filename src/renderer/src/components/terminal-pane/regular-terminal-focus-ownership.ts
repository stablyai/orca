export type TerminalInputFocusSync = (focused: boolean) => void
export const REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE = 'data-regular-terminal-input-focused'

export function isXtermHelperTextarea(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
}

export function setRegularTerminalInputFocusAttribute(focused: boolean): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.toggleAttribute(REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE, focused)
}

export function getPaneOwnedActiveHelperTextarea(
  container: HTMLElement,
  activeElement: Element | null
): HTMLElement | null {
  if (!isXtermHelperTextarea(activeElement) || !container.contains(activeElement)) {
    return null
  }
  return activeElement
}

export function releaseTerminalFocusForOutsidePointerDown(args: {
  container: HTMLElement
  activeElement: Element | null
  pointerTarget: EventTarget | null
  syncFocused: TerminalInputFocusSync
}): boolean {
  const activeHelper = getPaneOwnedActiveHelperTextarea(args.container, args.activeElement)
  if (!activeHelper) {
    return false
  }

  if (isNode(args.pointerTarget) && args.container.contains(args.pointerTarget)) {
    return false
  }

  args.syncFocused(false)
  activeHelper.blur()
  return true
}

export function releaseTerminalFocusForWindowBlur(args: {
  container: HTMLElement
  activeElement: Element | null
  syncFocused: TerminalInputFocusSync
}): boolean {
  if (!getPaneOwnedActiveHelperTextarea(args.container, args.activeElement)) {
    return false
  }

  args.syncFocused(false)
  return true
}

export function resyncTerminalFocusForWindowFocus(args: {
  container: HTMLElement
  activeElement: Element | null
  syncFocused: TerminalInputFocusSync
}): boolean {
  if (!getPaneOwnedActiveHelperTextarea(args.container, args.activeElement)) {
    return false
  }

  args.syncFocused(true)
  return true
}

function isNode(value: EventTarget | null): value is Node {
  return typeof Node !== 'undefined' && value instanceof Node
}
