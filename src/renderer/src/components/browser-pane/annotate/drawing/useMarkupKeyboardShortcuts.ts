import { useEffect } from 'react'

export type PendingText = { x: number; y: number; initial: string }

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export type MarkupKeyboardParams = {
  pendingText: PendingText | null
  setPendingText: (value: PendingText | null) => void
  undo: () => void
  redo: () => void
  onCancel: () => void
}

// Escape dismisses pending text before exiting; undo/redo follow platform shortcuts.
export function useMarkupKeyboardShortcuts(params: MarkupKeyboardParams): void {
  const { pendingText, setPendingText, undo, redo, onCancel } = params
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // An IME composition ends on Esc; an open menu or popover (Draw's style or ⋯ menu) closes first.
        if (
          event.isComposing ||
          event.keyCode === 229 ||
          event.defaultPrevented ||
          (event.target instanceof Element &&
            event.target.closest(
              '[data-slot="dropdown-menu-content"], [data-slot="popover-content"]'
            ))
        ) {
          return
        }
        if (pendingText) {
          setPendingText(null)
        } else {
          onCancel()
        }
        return
      }
      if (isTypingTarget(event.target)) {
        return
      }
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          redo()
        } else {
          undo()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingText, setPendingText, undo, redo, onCancel])
}
