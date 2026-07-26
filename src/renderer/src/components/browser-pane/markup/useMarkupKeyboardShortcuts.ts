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

// Window-level shortcuts for the markup overlay: Escape (close the open text box,
// else exit markup) and platform-correct undo/redo.
export function useMarkupKeyboardShortcuts(params: MarkupKeyboardParams): void {
  const { pendingText, setPendingText, undo, redo, onCancel } = params
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
