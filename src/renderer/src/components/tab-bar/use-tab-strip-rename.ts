import { useCallback, useRef, useState } from 'react'
import {
  isImeCompositionKeyDown,
  useImeEnterGestureOwnership
} from '@/lib/ime-composition-keyboard-event'

export function useTabStripRename({
  value,
  onCommit
}: {
  value: string
  onCommit: (value: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameFocusFrameRef = useRef<number | null>(null)
  const resolvedRef = useRef(false)
  const imeEnter = useImeEnterGestureOwnership()

  const handleRenameOpen = useCallback(() => {
    resolvedRef.current = false
    imeEnter.reset()
    // Why: background title updates must not replace a name the user is editing.
    setRenameValue(value)
    setIsEditing(true)
  }, [imeEnter, value])

  const commitRename = useCallback(() => {
    if (resolvedRef.current) {
      return
    }
    // Why: the input's trailing blur must not commit after Enter or Escape.
    resolvedRef.current = true
    imeEnter.reset()
    onCommit(renameValue.trim())
    setIsEditing(false)
  }, [imeEnter, onCommit, renameValue])

  const cancelRename = useCallback(() => {
    resolvedRef.current = true
    imeEnter.reset()
    setIsEditing(false)
  }, [imeEnter])

  const setRenameInputElement = useCallback((input: HTMLInputElement | null) => {
    if (renameFocusFrameRef.current !== null) {
      cancelAnimationFrame(renameFocusFrameRef.current)
      renameFocusFrameRef.current = null
    }
    if (!input) {
      return
    }
    // Why: Radix focus restoration must finish before the newly mounted field takes focus.
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      input.focus()
      input.select()
    })
  }, [])

  const onRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation()
    if (imeEnter.ownsKeyDown(event) || imeEnter.isComposing() || isImeCompositionKeyDown(event)) {
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRename()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelRename()
    }
  }

  return {
    isEditing,
    renameValue,
    setRenameValue,
    handleRenameOpen,
    commitRename,
    setRenameInputElement,
    onRenameKeyDown,
    onRenameKeyUp: imeEnter.onKeyUp,
    onRenameCompositionStart: () => imeEnter.setComposing(true),
    onRenameCompositionEnd: () => imeEnter.setComposing(false)
  }
}
