import { useEffect, useEffectEvent } from 'react'
import type { UnifiedTerminalItem } from './useTerminalTabs'
import { isUpdaterQuitAndInstallInProgress } from '@/lib/updater-beforeunload'

type UseTerminalShortcutsParams = {
  activeWorktreeId: string | null
  activeTabId: string | null
  activeFileId: string | null
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

    // Why: use event.code instead of event.key because on macOS, Shift+[
    // reports '{' as the key value (the shifted character), not '['.
    if (
      !event.shiftKey ||
      (event.code !== 'BracketRight' && event.code !== 'BracketLeft')
    ) {
      return
    }

    if (unifiedTabs.length <= 1) {
      return
    }

    event.preventDefault()
    const currentId = activeTabType === 'editor' ? activeFileId : activeTabId
    const currentIndex = unifiedTabs.findIndex((tab) => tab.id === currentId)
    const direction = event.code === 'BracketRight' ? 1 : -1
    const nextTab =
      unifiedTabs[(currentIndex + direction + unifiedTabs.length) % unifiedTabs.length]

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
