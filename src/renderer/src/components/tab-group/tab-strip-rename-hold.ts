import { useEffect, useRef, useState } from 'react'
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
 * Whether a tab rename addressed to this group is open. The strip mounts the rename input, and a
 * collapsed strip is inert, so the input could neither take focus nor ever close.
 */
export function useTabStripRenameHold({
  enabled,
  panelRef,
  ownsTab
}: {
  enabled: boolean
  panelRef: React.RefObject<HTMLElement | null>
  ownsTab: (tabId: string) => boolean
}): boolean {
  const [renameOpen, setRenameOpen] = useState(false)
  const ownsTabRef = useRef(ownsTab)
  useEffect(() => {
    ownsTabRef.current = ownsTab
  }, [ownsTab])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const onRenameRequest = (event: Event): void => {
      const tabId = readRenameRequestTabId(event)
      if (tabId !== null && ownsTabRef.current(tabId)) {
        setRenameOpen(true)
      }
    }
    window.addEventListener(RENAME_TERMINAL_TAB_EVENT, onRenameRequest)
    return () => window.removeEventListener(RENAME_TERMINAL_TAB_EVENT, onRenameRequest)
  }, [enabled])

  useEffect(() => {
    if (!renameOpen) {
      return
    }
    const panel = panelRef.current
    if (!panel) {
      setRenameOpen(false)
      return
    }
    // Why: the rename ends by unmounting its input; that removal is the only signal the tab gives.
    const releaseOnceInputIsGone = (): void => {
      if (!panel.querySelector(TAB_RENAME_INPUT_SELECTOR)) {
        setRenameOpen(false)
      }
    }
    const observer = new MutationObserver(releaseOnceInputIsGone)
    observer.observe(panel, { childList: true, subtree: true })
    releaseOnceInputIsGone()
    return () => observer.disconnect()
  }, [renameOpen, panelRef])

  return enabled && renameOpen
}
