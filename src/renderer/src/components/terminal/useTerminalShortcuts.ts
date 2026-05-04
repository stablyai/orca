import { useEffect, useEffectEvent } from 'react'
import type { UnifiedTerminalItem } from './useTerminalTabs'
import { getNextTabAcrossAllTypes, getNextTabWithinActiveType } from './tab-type-cycle'
import { isUpdaterQuitAndInstallInProgress } from '@/lib/updater-beforeunload'

type UseTerminalShortcutsParams = {
  activeWorktreeId: string | null
  activeTabId: string | null
  activeFileId: string | null
  // Why: unifiedTabs only contains 'terminal' | 'editor' entries (no browsers),
  // so this hook's cycling is constrained to those two types. Browser tab
  // cycling is handled elsewhere where browser tabs are actually in scope.
  activeTabType: 'terminal' | 'editor'
  unifiedTabs: UnifiedTerminalItem[]
  hasDirtyFiles: boolean
  onNewTab: () => void
  onCloseTab: (tabId: string) => void
  onCloseFile: (fileId: string) => void
  onActivateTerminalTab: (tabId: string) => void
  onActivateEditorTab: (fileId: string) => void
}

export function useTerminalShortcuts({
  activeWorktreeId,
  activeTabId,
  activeFileId,
  activeTabType,
  unifiedTabs,
  hasDirtyFiles,
  onNewTab,
  onCloseTab,
  onCloseFile,
  onActivateTerminalTab,
  onActivateEditorTab
}: UseTerminalShortcutsParams): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    // Accept Cmd on macOS, Ctrl on other platforms
    const isMac = navigator.userAgent.includes('Mac')
    const mod = isMac ? event.metaKey : event.ctrlKey
    if (!activeWorktreeId || !mod || event.repeat) {
      return
    }

    if (event.key === 't' && !event.shiftKey) {
      event.preventDefault()
      onNewTab()
      return
    }

    if (event.key === 'w' && !event.shiftKey) {
      event.preventDefault()
      if (activeTabType === 'editor' && activeFileId) {
        onCloseFile(activeFileId)
      } else if (activeTabId) {
        onCloseTab(activeTabId)
      }
      return
    }

    // Why: accept either Shift (type-scoped chord) or Alt (all-types chord).
    // Use event.code rather than event.key because on macOS, Shift+[ reports
    // '{' and Option+[ composes to a dead/accent character, so event.key
    // wouldn't reliably match across layouts.
    if (
      (!event.shiftKey && !event.altKey) ||
      (event.code !== 'BracketRight' && event.code !== 'BracketLeft')
    ) {
      return
    }

    const direction = event.code === 'BracketRight' ? 1 : -1
    // Why: UnifiedTerminalItem has { type: 'terminal' | 'editor', id }, which is
    // structurally assignable to TypeCyclableTab ({ type, id, tabId? }) with a
    // narrower `type`. No cast needed — passing null for activeBrowserTabId
    // since browser tabs can never appear in unifiedTabs.
    const nextTab = event.altKey
      ? getNextTabAcrossAllTypes({
          tabs: unifiedTabs,
          activeTabType,
          activeTabId,
          activeFileId,
          activeBrowserTabId: null,
          direction
        })
      : getNextTabWithinActiveType({
          tabs: unifiedTabs,
          activeTabType,
          activeTabId,
          activeFileId,
          activeBrowserTabId: null,
          direction
        })
    if (!nextTab) {
      return
    }

    event.preventDefault()

    if (nextTab.type === 'terminal') {
      onActivateTerminalTab(nextTab.id)
      return
    }

    onActivateEditorTab(nextTab.id)
  })

  const handleBeforeUnload = useEffectEvent((event: BeforeUnloadEvent) => {
    if (isUpdaterQuitAndInstallInProgress()) {
      return
    }
    if (!hasDirtyFiles) {
      return
    }
    event.preventDefault()
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => handleKeyDown(event)
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- handleKeyDown is a useEffectEvent

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => handleBeforeUnload(event)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- handleBeforeUnload is a useEffectEvent
}
