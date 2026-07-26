import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'

export function useSortableTabRename({
  tab,
  onSetCustomTitle
}: {
  tab: TerminalTab
  onSetCustomTitle: (tabId: string, title: string | null) => void
}): {
  isEditing: boolean
  renameValue: string
  setRenameValue: (val: string) => void
  handleRenameOpen: () => void
  commitRename: () => void
  cancelRename: () => void
  setRenameInputElement: (input: HTMLInputElement | null) => void
} {
  const renamingTabId = useAppStore((s) => s.renamingTabId)
  const setRenamingTabId = useAppStore((s) => s.setRenamingTabId)

  const [isEditing, setIsEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameFocusFrameRef = useRef<number | null>(null)
  const committedOrCancelledRef = useRef(false)

  const handleRenameOpen = useCallback(() => {
    committedOrCancelledRef.current = false
    setRenameValue(tab.customTitle ?? tab.title)
    setIsEditing(true)
  }, [tab.customTitle, tab.title])

  const commitRename = useCallback(() => {
    if (committedOrCancelledRef.current) {
      return
    }
    committedOrCancelledRef.current = true
    const trimmed = renameValue.trim()
    onSetCustomTitle(tab.id, trimmed.length > 0 ? trimmed : null)
    setIsEditing(false)
  }, [renameValue, onSetCustomTitle, tab.id])

  const cancelRename = useCallback(() => {
    committedOrCancelledRef.current = true
    setIsEditing(false)
  }, [])

  const setRenameInputElement = useCallback((input: HTMLInputElement | null) => {
    if (renameFocusFrameRef.current !== null) {
      cancelAnimationFrame(renameFocusFrameRef.current)
      renameFocusFrameRef.current = null
    }
    if (!input) {
      return
    }
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      input.focus()
      input.select()
    })
  }, [])

  useEffect(() => {
    if (renamingTabId !== tab.id) {
      return
    }
    handleRenameOpen()
    setRenamingTabId(null)
  }, [renamingTabId, tab.id, handleRenameOpen, setRenamingTabId])

  useEffect(() => {
    return () => {
      if (renameFocusFrameRef.current !== null) {
        cancelAnimationFrame(renameFocusFrameRef.current)
      }
    }
  }, [])

  return {
    isEditing,
    renameValue,
    setRenameValue,
    handleRenameOpen,
    commitRename,
    cancelRename,
    setRenameInputElement
  }
}
