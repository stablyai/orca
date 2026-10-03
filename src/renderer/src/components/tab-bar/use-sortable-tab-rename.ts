import { useEffect, useRef } from 'react'
import {
  RENAME_TERMINAL_TAB_EVENT,
  type RenameTerminalTabDetail
} from './terminal-tab-rename-request'
import { useTabStripRename } from './use-tab-strip-rename'

// Why: terminal OSC titles can change during editing; the shared rename state snapshots the opening value.
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
  const rename = useTabStripRename({
    value: customTitle ?? title,
    onCommit: (value) => onSetCustomTitle(tabId, value || null)
  })
  const { handleRenameOpen } = rename

  // Why: keep the window listener stable across OSC title updates.
  const handleRenameOpenRef = useRef(handleRenameOpen)
  useEffect(() => {
    handleRenameOpenRef.current = handleRenameOpen
  }, [handleRenameOpen])

  useEffect(() => {
    const onRenameRequest = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        return
      }
      const detail: RenameTerminalTabDetail | undefined = event.detail
      if (detail?.tabId !== tabId) {
        return
      }
      handleRenameOpenRef.current()
    }
    window.addEventListener(RENAME_TERMINAL_TAB_EVENT, onRenameRequest)
    return () => window.removeEventListener(RENAME_TERMINAL_TAB_EVENT, onRenameRequest)
  }, [tabId])

  return rename
}
