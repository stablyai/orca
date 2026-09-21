import { useEffect, useState, type RefObject } from 'react'
import { getPaneOwnedActiveHelperTextarea } from '../terminal-pane/regular-terminal-focus-ownership'

export function hasSessionGridTerminalFocus(container: HTMLElement): boolean {
  const document = container.ownerDocument
  return (
    document.hasFocus() &&
    getPaneOwnedActiveHelperTextarea(container, document.activeElement) !== null
  )
}

/** Selection can survive blur; the scroll affordance must follow the actual keyboard owner. */
export function useSessionGridTerminalFocus(containerRef: RefObject<HTMLElement | null>): boolean {
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const document = container.ownerDocument
    const window = document.defaultView
    let disposed = false
    const sync = (): void => {
      if (!disposed) {
        setFocused(hasSessionGridTerminalFocus(container))
      }
    }
    const onFocus = (): void => {
      sync()
      // activeElement can still be body during focusout dispatch.
      queueMicrotask(sync)
    }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', onFocus)
    window?.addEventListener('focus', onFocus)
    window?.addEventListener('blur', onFocus)
    sync()
    return () => {
      disposed = true
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', onFocus)
      window?.removeEventListener('focus', onFocus)
      window?.removeEventListener('blur', onFocus)
    }
  }, [containerRef])
  return focused
}
