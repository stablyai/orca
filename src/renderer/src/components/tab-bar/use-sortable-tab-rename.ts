import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RENAME_TERMINAL_TAB_EVENT,
  type RenameTerminalTabDetail
} from './terminal-tab-rename-request'

/** Inline tab-title rename: snapshots the title on open so mid-edit OSC churn
 *  cannot overwrite the user's text, commits at most once, and answers the
 *  window rename request addressed to this tab. */
export function useSortableTabRename({
  tabId,
  title,
  customTitle,
  onSetCustomTitle
}: {
  tabId: string
  title: string
  customTitle?: string | null
  onSetCustomTitle: (tabId: string, title: string | null) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameFocusFrameRef = useRef<number | null>(null)
  // Why: onBlur fires during Input unmount; mark rename resolved so it can't re-commit and overwrite discarded edits.
  const committedOrCancelledRef = useRef(false)

  const handleRenameOpen = useCallback(() => {
    committedOrCancelledRef.current = false
    // Why: snapshot title once; don't refresh if tab.title changes mid-edit (e.g. OSC) so the user's edits aren't overwritten.
    setRenameValue(customTitle ?? title)
    setIsEditing(true)
  }, [customTitle, title])

  const commitRename = useCallback(() => {
    if (committedOrCancelledRef.current) {
      return
    }
    committedOrCancelledRef.current = true
    const trimmed = renameValue.trim()
    onSetCustomTitle(tabId, trimmed.length > 0 ? trimmed : null)
    setIsEditing(false)
  }, [renameValue, onSetCustomTitle, tabId])

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

  // Why the ref: keeps the listener subscribed to tabId alone, so OSC title churn can't
  // resubscribe it mid-edit. Written from an Effect, not in render -- a render React discards
  // must not leave a stale handler behind for the next commit to fire.
  const handleRenameOpenRef = useRef(handleRenameOpen)
  useEffect(() => {
    handleRenameOpenRef.current = handleRenameOpen
  }, [handleRenameOpen])

  useEffect(() => {
    const onRenameRequest = (event: Event): void => {
      const detail = (event as CustomEvent<RenameTerminalTabDetail | undefined>).detail
      if (detail?.tabId !== tabId) {
        return
      }
      handleRenameOpenRef.current()
    }
    window.addEventListener(RENAME_TERMINAL_TAB_EVENT, onRenameRequest)
    return () => window.removeEventListener(RENAME_TERMINAL_TAB_EVENT, onRenameRequest)
  }, [tabId])

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
