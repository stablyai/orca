import { useEffect } from 'react'
import type React from 'react'
import { deleteShapeFromDocument } from './markup-editor-document'
import type { MarkupDocument } from './markup-drawing-model'

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
  selectedIdRef: React.MutableRefObject<string | null>
  setPendingText: (value: PendingText | null) => void
  setEditingTextId: (value: string | null) => void
  select: (id: string | null) => void
  setDoc: React.Dispatch<React.SetStateAction<MarkupDocument>>
  undo: () => void
  redo: () => void
  onCancel: () => void
}

// Window-level shortcuts for the markup overlay: Escape (close text / deselect /
// exit), Delete/Backspace (remove selection), and platform-correct undo/redo.
export function useMarkupKeyboardShortcuts(params: MarkupKeyboardParams): void {
  const {
    pendingText,
    selectedIdRef,
    setPendingText,
    setEditingTextId,
    select,
    setDoc,
    undo,
    redo,
    onCancel
  } = params
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (pendingText) {
          setPendingText(null)
          setEditingTextId(null)
        } else if (selectedIdRef.current) {
          select(null)
        } else {
          onCancel()
        }
        return
      }
      if (isTypingTarget(event.target)) {
        return
      }
      const selectedForDelete = selectedIdRef.current
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedForDelete) {
        event.preventDefault()
        setDoc((document) => deleteShapeFromDocument(document, selectedForDelete))
        select(null)
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
  }, [
    pendingText,
    selectedIdRef,
    setPendingText,
    setEditingTextId,
    select,
    setDoc,
    undo,
    redo,
    onCancel
  ])
}
