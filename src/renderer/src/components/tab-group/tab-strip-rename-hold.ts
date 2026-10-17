import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { RENAME_TERMINAL_TAB_EVENT } from '../tab-bar/terminal-tab-rename-request'

const TAB_RENAME_INPUT_SELECTOR = '[data-tab-rename-input="true"]'

function readRenameRequestTabId(event: Event): string | null {
  const detail: unknown = 'detail' in event ? event.detail : null
  return typeof detail === 'object' &&
    detail !== null &&
    'tabId' in detail &&
    typeof detail.tabId === 'string'
    ? detail.tabId
    : null
}

/**
 * Whether a tab rename in this group's strip is open. A collapsed strip is inert, so a rename
 * input mounted in it could neither take focus nor ever close; the strip must stay open for it.
 */
export function useTabStripRenameHold({
  enabled,
  ownsTab
}: {
  enabled: boolean
  /** Whether a rename request's tab id belongs to this group's strip. */
  ownsTab: (tabId: string) => boolean
}): {
  renameActive: boolean
  /** Attach to the strip row; the hold watches it for the rename input. */
  setStripRowNode: (node: HTMLElement | null) => void
} {
  const [stripRowNode, setStripRowNode] = useState<HTMLElement | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const ownsTabRef = useRef(ownsTab)
  useEffect(() => {
    ownsTabRef.current = ownsTab
  }, [ownsTab])

  useEffect(() => {
    if (!enabled || !stripRowNode) {
      return
    }
    // Why: a double-click or the context menu opens the editor without any event, so the input's
    // presence is the one signal every path shares — and its removal is how the rename ends.
    const readRenameOpen = (): boolean =>
      stripRowNode.querySelector(TAB_RENAME_INPUT_SELECTOR) !== null
    const observer = new MutationObserver(() => {
      // Why: synchronous — the tab focuses its input on the next frame, and the strip must be open by then.
      flushSync(() => setRenameOpen(readRenameOpen()))
    })
    observer.observe(stripRowNode, { childList: true, subtree: true })
    // Why: the shortcut's request is answered in the same commit, so holding on the event opens the
    // strip together with the input rather than a mutation callback later.
    const onRenameRequest = (event: Event): void => {
      const tabId = readRenameRequestTabId(event)
      if (tabId !== null && ownsTabRef.current(tabId)) {
        setRenameOpen(true)
      }
    }
    window.addEventListener(RENAME_TERMINAL_TAB_EVENT, onRenameRequest)
    setRenameOpen(readRenameOpen())
    return () => {
      observer.disconnect()
      window.removeEventListener(RENAME_TERMINAL_TAB_EVENT, onRenameRequest)
    }
  }, [enabled, stripRowNode])

  // Why: a request no tab answered would otherwise hold the strip open with nothing to edit.
  useEffect(() => {
    if (renameOpen && !stripRowNode?.querySelector(TAB_RENAME_INPUT_SELECTOR)) {
      setRenameOpen(false)
    }
  }, [renameOpen, stripRowNode])

  return { renameActive: enabled && renameOpen, setStripRowNode }
}
