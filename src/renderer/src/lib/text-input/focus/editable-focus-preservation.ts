const SIDEBAR_LIST_KEYBOARD_NAVIGATION = '[data-worktree-sidebar][data-keyboard-navigation]'

/** An explicit pane focus request (CLI, notification, agent row) outranks sidebar list navigation. */
export function endSidebarListKeyboardNavigation(): void {
  if (typeof document === 'undefined') {
    return
  }
  document
    .querySelector(SIDEBAR_LIST_KEYBOARD_NAVIGATION)
    ?.removeAttribute('data-keyboard-navigation')
}

export function shouldPreserveEditableFocus(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false
  }
  if (element.classList.contains('xterm-helper-textarea') || element.closest('.xterm')) {
    return false
  }
  // Why: a field in a just-hidden pane keeps focus until Chromium drops it to body a task later.
  if (element.closest('[hidden], [inert]')) {
    return false
  }
  // Deferred layout maintenance must not steal focus from rename or settings edits.
  return (
    element.matches(SIDEBAR_LIST_KEYBOARD_NAVIGATION) ||
    element.isContentEditable ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  )
}
