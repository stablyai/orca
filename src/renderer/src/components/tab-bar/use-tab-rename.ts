import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalTab } from '../../../../shared/types'

type UseTabRenameArgs = {
  tab: TerminalTab
  renamingTabId: string | null
  setRenamingTabId: (id: string | null) => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
}

type UseTabRenameResult = {
  isEditing: boolean
  renameValue: string
  setRenameValue: (value: string) => void
  handleRenameOpen: () => void
  commitRename: () => void
  cancelRename: () => void
  setRenameInputElement: (input: HTMLInputElement | null) => void
}

export function useTabRename({
  tab,
  renamingTabId,
  setRenamingTabId,
  onSetCustomTitle
}: UseTabRenameArgs): UseTabRenameResult {
  const [isEditing, setIsEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameFocusFrameRef = useRef<number | null>(null)
  // Why: onBlur fires during Input unmount; mark rename resolved so it can't re-commit and overwrite discarded edits.
  const committedOrCancelledRef = useRef(false)

  const handleRenameOpen = useCallback(() => {
    committedOrCancelledRef.current = false
    // Why: snapshot title once; don't refresh if tab.title changes mid-edit (e.g. OSC) so the user's edits aren't overwritten.
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
    // Why: defer past Radix menu teardown/focus restore; key off input mount so title updates don't re-select edited text.
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      input.focus()
      input.select()
    })
  }, [])

  // Why: the tab.rename shortcut routes through store renamingTabId; open the editor and clear it so it fires once.
  useEffect(() => {
    if (renamingTabId !== tab.id) {
      return
    }
    handleRenameOpen()
    setRenamingTabId(null)
  }, [renamingTabId, tab.id, handleRenameOpen, setRenamingTabId])

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
