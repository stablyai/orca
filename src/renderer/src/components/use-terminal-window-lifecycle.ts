import { useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { isIntentionalAppRestartInProgress } from '@/lib/updater-beforeunload'
import { preventUnloadAndScheduleShutdownCheckpointReset } from '@/lib/shutdown-checkpoint-guard'
import { setWindowCloseRequestHandler } from './window-close-request-coordinator'
import {
  collectBrowserWebviewIds,
  destroyRemovedBrowserWebview
} from '../store/slices/browser-webview-cleanup'
import type { TerminalActivationController } from './use-terminal-activation-actions'

export function useTerminalWindowLifecycle(controller: TerminalActivationController): void {
  const {
    activeBrowserTabId,
    activeTabType,
    activeWorktreeBrowserTabIdsKey,
    proceedToNativeWindowClose,
    queueEditorCloseRequests,
    renderedActiveWorktreeId,
    setActiveBrowserTab,
    setActiveTabType,
    windowCloseAfterDirtyRef
  } = controller
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (isIntentionalAppRestartInProgress()) {
        return
      }
      const dirtyFiles = useAppStore.getState().openFiles.filter((file) => file.isDirty)
      if (dirtyFiles.length > 0) {
        preventUnloadAndScheduleShutdownCheckpointReset(event, window)
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  useEffect(() => {
    setWindowCloseRequestHandler(({ isQuitting }) => {
      if (isIntentionalAppRestartInProgress()) {
        window.api.ui.confirmWindowClose()
        return
      }
      if (windowCloseAfterDirtyRef.current) {
        return
      }
      const dirtyFiles = useAppStore.getState().openFiles.filter((file) => file.isDirty)
      if (dirtyFiles.length > 0) {
        queueEditorCloseRequests(
          dirtyFiles.map((file) => file.id),
          { isQuitting }
        )
        return
      }
      proceedToNativeWindowClose(isQuitting)
    })
    return () => setWindowCloseRequestHandler(null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
  }, [proceedToNativeWindowClose, queueEditorCloseRequests])

  // Why lazy: a `useRef(expr)` argument re-runs on every render and is thrown away, and this
  // walks every browser page and tab across all worktrees on a component that renders constantly.
  const prevBrowserWebviewIdsRef = useRef<Set<string>>(undefined!)
  prevBrowserWebviewIdsRef.current ??= collectBrowserWebviewIds(
    useAppStore.getState().browserTabsByWorktree,
    useAppStore.getState().browserPagesByWorkspace
  )
  useEffect(() => {
    let prevBrowserTabs = useAppStore.getState().browserTabsByWorktree
    let prevBrowserPages = useAppStore.getState().browserPagesByWorkspace
    return useAppStore.subscribe((state) => {
      if (
        state.browserTabsByWorktree === prevBrowserTabs &&
        state.browserPagesByWorkspace === prevBrowserPages
      ) {
        return
      }
      prevBrowserTabs = state.browserTabsByWorktree
      prevBrowserPages = state.browserPagesByWorkspace
      const currentIds = collectBrowserWebviewIds(
        state.browserTabsByWorktree,
        state.browserPagesByWorkspace
      )
      for (const prevId of prevBrowserWebviewIdsRef.current) {
        if (!currentIds.has(prevId)) {
          destroyRemovedBrowserWebview(prevId)
        }
      }
      prevBrowserWebviewIdsRef.current = currentIds
    })
  }, [])

  useEffect(() => {
    const activeWorktreeBrowserTabs = renderedActiveWorktreeId
      ? (useAppStore.getState().browserTabsByWorktree[renderedActiveWorktreeId] ?? [])
      : []
    if (
      activeTabType === 'browser' &&
      renderedActiveWorktreeId &&
      (!activeBrowserTabId ||
        !activeWorktreeBrowserTabs.some((tab) => tab.id === activeBrowserTabId))
    ) {
      const fallbackBrowserTab = activeWorktreeBrowserTabs[0]
      if (fallbackBrowserTab) {
        setActiveBrowserTab(fallbackBrowserTab.id)
      } else {
        setActiveTabType('terminal')
      }
    }
  }, [
    activeTabType,
    renderedActiveWorktreeId,
    activeBrowserTabId,
    activeWorktreeBrowserTabIdsKey,
    setActiveBrowserTab,
    setActiveTabType
  ])
}
