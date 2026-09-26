// Why: arrowing through the focused workspace list must not let each new terminal take focus (#22903);
// a click in the list or focus leaving it ends this, so those still focus the terminal.
let navigatingList: Element | null = null

export function endWorktreeListKeyboardNavigation(): void {
  const list = navigatingList
  navigatingList = null
  list?.removeEventListener('focusout', endWorktreeListKeyboardNavigation)
  list?.removeEventListener('pointerdown', endWorktreeListKeyboardNavigation, true)
}

export function beginWorktreeListKeyboardNavigation(list: Element): void {
  if (navigatingList === list) {
    return
  }
  endWorktreeListKeyboardNavigation()
  navigatingList = list
  list.addEventListener('focusout', endWorktreeListKeyboardNavigation)
  list.addEventListener('pointerdown', endWorktreeListKeyboardNavigation, true)
}

export function isWorktreeListKeyboardNavigationActive(): boolean {
  return navigatingList !== null && document.activeElement === navigatingList
}
