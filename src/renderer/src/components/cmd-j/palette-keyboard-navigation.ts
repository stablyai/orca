import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'

export function isPaletteNavigationKeyDown(event: {
  key: string
  ctrlKey: boolean
  defaultPrevented: boolean
  keyCode?: number
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}): boolean {
  if (event.defaultPrevented || isImeOwnedKeyboardEvent(event)) {
    return false
  }
  return (
    ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key) ||
    // cmdk enables these Control bindings on every platform.
    (event.ctrlKey && ['n', 'p', 'j', 'k'].includes(event.key))
  )
}
