export function isEventTargetInsideCurrentTarget(
  currentTarget: EventTarget | null,
  target: EventTarget | null
): boolean {
  if (!(currentTarget instanceof Node) || !(target instanceof Node)) {
    return false
  }
  return currentTarget.contains(target)
}

// Touch and pen keep click activation so a press can still start a scroll.
export function isPlainPrimaryMousePress(event: {
  pointerType: string
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return (
    event.pointerType === 'mouse' &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

// Selectable text (e.g. port numbers) lets a press start a text selection; it keeps click activation.
export function isSelectableTextTarget(target: EventTarget | null): boolean {
  return target instanceof Element && getComputedStyle(target).userSelect === 'text'
}

// The click that ends a gesture is dispatched right after pointerup, so clear after that task; cancel never clicks.
export function afterPointerGestureEnds(callback: () => void): void {
  const finish = (event: Event): void => {
    window.removeEventListener('pointerup', finish, true)
    window.removeEventListener('pointercancel', finish, true)
    if (event.type === 'pointercancel') {
      callback()
    } else {
      setTimeout(callback, 0)
    }
  }
  window.addEventListener('pointerup', finish, true)
  window.addEventListener('pointercancel', finish, true)
}
