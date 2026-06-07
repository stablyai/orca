/* eslint-disable max-lines */

import React, { useEffect, useCallback, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  TOGGLE_TERMINAL_PANE_EXPAND_EVENT,
  type BackgroundMountTerminalWorktreeDetail
} from '@/constants/terminal'
import { useAppStore } from '../store'
import { useAllWorktrees } from '../store/selectors'
import { getConnectionId } from '../lib/connection-context'
import { basename } from '../lib/path'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import TabBar from './tab-bar/TabBar'
import TerminalPane from './terminal-pane/TerminalPane'
import {
  ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestFileCloseDetail,
  requestEditorSaveQuiesce
} from './editor/editor-autosave'
import { isIntentionalAppRestartInProgress } from '@/lib/updater-beforeunload'
import EditorAutosaveController from './editor/EditorAutosaveController'
import type { Tab, TabContentType, TabGroupLayoutNode } from '../../../shared/types'
import { hasFeatureInteraction } from '../../../shared/feature-interactions'
import BrowserPane from './browser-pane/BrowserPane'
import BrowserPaneOverlayLayer from './browser-pane/BrowserPaneOverlayLayer'
import { useBrowserAutomationVisibilityForAny } from './browser-pane/browser-automation-visibility'
import TerminalPaneOverlayLayer from './terminal-pane/TerminalPaneOverlayLayer'
import {
  collectBrowserWebviewIds,
  destroyRemovedBrowserWebview,
  destroyWorkspaceWebviews
} from '../store/slices/browser-webview-cleanup'
import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from '../hooks/ipc-tab-switch'
import TabGroupSplitLayout from './tab-group/TabGroupSplitLayout'
import { shouldAutoCreateInitialTerminal } from './terminal/initial-terminal'
import { shouldRepairActiveTerminalTab } from './terminal/active-terminal-repair'
import { addBackgroundMountedTerminalWorktree } from './terminal/background-terminal-worktree-mount'
import {
  getEffectiveLayoutForWorktree as getEffectiveLayout,
  anyMountedWorktreeHasLayout as computeAnyMountedWorktreeHasLayout
} from './terminal/split-group-mount'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { appendUniqueOpenFileIds } from './terminal/unsaved-close-queue'
import CodexRestartChip from './CodexRestartChip'
import {
  findActivityTerminalPortal,
  useActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from './activity/activity-terminal-portal'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab,
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import {
  createFloatingWorkspaceBrowserTab,
  createFloatingWorkspaceMarkdownTab,
  createFloatingWorkspaceTerminalTab,
  handleEmptyFloatingWorkspacePanelCloseShortcut,
  isFloatingWorkspacePanelFocused,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingContext
} from '../../../shared/keybindings'
import { matchesRecentTabSwitcherChord } from '../../../shared/window-shortcut-policy'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { useContextualTour } from './contextual-tours/use-contextual-tour'
import { openTabBarEntry, type TabCreateEntryArgs } from './tab-bar/tab-create-entry-action'
import { closeTerminalTab } from './terminal/terminal-tab-actions'

const EditorPanel = lazy(() => import('./editor/EditorPanel'))

// Why: after a close-dialog handler advances the queue and renders the next
// dialog, gate new handler runs for this long so a stray carry-over click
// from the prior dialog can't silently act on the new one. Short enough to
// feel responsive on a deliberate follow-up click; long enough to absorb the
// trailing edge of a physical double-click (~150 ms on most hardware).
const CLOSE_DIALOG_DEBOUNCE_MS = 200
const EDITOR_TAB_CONTENT_TYPES = new Set<TabContentType>(['editor', 'diff', 'conflict-review'])

type TerminalStoreSnapshot = ReturnType<typeof useAppStore.getState>

function findUnifiedTabByVisibleId(
  state: TerminalStoreSnapshot,
  worktreeId: string,
  visibleId: string
): Tab | null {
  return (
    (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.id === visibleId || tab.entityId === visibleId
    ) ?? null
  )
}

function findActiveUnifiedTab(state: TerminalStoreSnapshot, worktreeId: string): Tab | null {
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const group =
    (state.groupsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === activeGroupId
    ) ?? null
  if (!group?.activeTabId) {
    return null
  }
  return (
    (state.unifiedTabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === group.activeTabId) ??
    null
  )
}

function isPinnedVisibleTab(
  state: TerminalStoreSnapshot,
  worktreeId: string,
  visibleId: string
): boolean {
  return findUnifiedTabByVisibleId(state, worktreeId, visibleId)?.isPinned === true
}

function isPinnedActiveEditorTab(
  state: TerminalStoreSnapshot,
  worktreeId: string,
  fileId: string
): boolean {
  const activeTab = findActiveUnifiedTab(state, worktreeId)
  if (activeTab) {
    return (
      activeTab.entityId === fileId &&
      EDITOR_TAB_CONTENT_TYPES.has(activeTab.contentType) &&
      activeTab.isPinned === true
    )
  }
  return (
    (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
      (tab) =>
        tab.entityId === fileId &&
        EDITOR_TAB_CONTENT_TYPES.has(tab.contentType) &&
        tab.isPinned === true
    ) ?? false
  )
}

function isPinnedEditorFileTab(
  state: TerminalStoreSnapshot,
  worktreeId: string,
  fileId: string
): boolean {
  return (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
    (tab) =>
      tab.entityId === fileId && EDITOR_TAB_CONTENT_TYPES.has(tab.contentType) && tab.isPinned
  )
}

function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
    ? 'terminal'
    : 'app'
}

function Terminal(): React.JSX.Element | null {
  const mountedWorktreeIdsRef = useRef(new Set<string>())
  const measurableBackgroundWorktreeIdsRef = useRef(new Set<string>())
  const allWorktrees = useAllWorktrees()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const renderedActiveWorktreeId = activeWorktreeId
  const activeView = useAppStore((s) => s.activeView)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => s.settings?.activeRuntimeEnvironmentId ?? null
  )
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const consumeSuppressedPtyExit = useAppStore((s) => s.consumeSuppressedPtyExit)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const openFiles = useAppStore((s) => s.openFiles)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const activeBrowserTabId = useAppStore((s) => s.activeBrowserTabId)
  const activeTabType = useAppStore((s) => s.activeTabType)
  const keybindings = useAppStore((s) => s.keybindings)
  const terminalShortcutPolicy = useAppStore(
    (s) => s.settings?.terminalShortcutPolicy ?? 'orca-first'
  )
  const setActiveTabType = useAppStore((s) => s.setActiveTabType)
  const setActiveFile = useAppStore((s) => s.setActiveFile)
  const closeFile = useAppStore((s) => s.closeFile)
  const makePreviewFilePermanent = useAppStore((s) => s.makePreviewFilePermanent)
  const pinFile = useAppStore((s) => s.pinFile)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const openNewBrowserTabInActiveWorkspace = useAppStore(
    (s) => s.openNewBrowserTabInActiveWorkspace
  )
  const openNewMarkdownInActiveWorkspace = useAppStore((s) => s.openNewMarkdownInActiveWorkspace)
  const openNewTerminalTabInActiveWorkspace = useAppStore(
    (s) => s.openNewTerminalTabInActiveWorkspace
  )
  const closeBrowserTab = useAppStore((s) => s.closeBrowserTab)
  const setActiveBrowserTab = useAppStore((s) => s.setActiveBrowserTab)
  const groupsByWorktree = useAppStore((s) => s.groupsByWorktree)
  const layoutByWorktree = useAppStore((s) => s.layoutByWorktree)
  const activeGroupIdByWorktree = useAppStore((s) => s.activeGroupIdByWorktree)
  const ensureWorktreeRootGroup = useAppStore((s) => s.ensureWorktreeRootGroup)
  const reconcileWorktreeTabModel = useAppStore((s) => s.reconcileWorktreeTabModel)

  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const setTabBarOrder = useAppStore((s) => s.setTabBarOrder)
  const tabBarOrderByWorktree = useAppStore((s) => s.tabBarOrderByWorktree)
  const tabBarOrder = renderedActiveWorktreeId
    ? tabBarOrderByWorktree[renderedActiveWorktreeId]
    : undefined
  // Why (anchored to selected thread, not active tab): the activity page
  // publishes the full {target, worktreeId, tabId} descriptor sourced from
  // its selectedThread. Deriving worktreeId/tabId from activeWorktreeId/
  // activeTabId here used to flash the wrong terminal — selectThread updates
  // the store in multiple steps and intermediate renders briefly pointed the
  // portal at the new worktree's stale last-active tab.
  const activityTerminalPortals: ActivityTerminalPortalTarget[] = useActivityTerminalPortals(
    activeView === 'activity'
  )

  const tabs = useMemo(
    () => (renderedActiveWorktreeId ? (tabsByWorktree[renderedActiveWorktreeId] ?? []) : []),
    [renderedActiveWorktreeId, tabsByWorktree]
  )

  // Why: the TabBar is rendered into the titlebar via a portal so tabs share
  // the same row as the "Orca" title. The target element is created by App.tsx.
  const titlebarTabsTarget = document.getElementById('titlebar-tabs')

  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }
    // Why: split-group ownership is now the real path. Ensure the active
    // worktree always has a root group so terminal-first fallback can attach
    // fresh tabs to a concrete owner even before any explicit split exists.
    ensureWorktreeRootGroup(activeWorktreeId)
  }, [activeWorktreeId, ensureWorktreeRootGroup])

  // Filter editor files to only show those belonging to the active worktree
  const worktreeFiles = renderedActiveWorktreeId
    ? openFiles.filter((f) => f.worktreeId === renderedActiveWorktreeId)
    : []
  const worktreeBrowserTabs = renderedActiveWorktreeId
    ? (browserTabsByWorktree[renderedActiveWorktreeId] ?? [])
    : []
  const getEffectiveLayoutForWorktree = useCallback(
    (worktreeId: string) =>
      getEffectiveLayout(worktreeId, layoutByWorktree, groupsByWorktree, activeGroupIdByWorktree),
    [activeGroupIdByWorktree, groupsByWorktree, layoutByWorktree]
  )
  const effectiveActiveLayout = renderedActiveWorktreeId
    ? getEffectiveLayoutForWorktree(renderedActiveWorktreeId)
    : undefined
  const activeWorktreeBrowserTabIdsKey = renderedActiveWorktreeId
    ? (browserTabsByWorktree[renderedActiveWorktreeId] ?? []).map((tab) => tab.id).join(',')
    : ''
  const activeContextualTourId = useAppStore((s) => s.activeContextualTourId)
  const hasSplitTerminalPane = useAppStore((s) =>
    hasFeatureInteraction(s.featureInteractions, 'terminal-pane-split')
  )

  useContextualTour(
    'workspace-agent-sessions',
    Boolean(
      activeWorktreeId &&
      activeView === 'terminal' &&
      workspaceSessionReady &&
      activeTabType === 'terminal' &&
      Boolean(activeTabId) &&
      (!hasSplitTerminalPane || activeContextualTourId === 'workspace-agent-sessions')
    ),
    'workspace_agent_sessions_visible'
  )

  // Save confirmation dialog state
  const [saveDialogFileId, setSaveDialogFileId] = useState<string | null>(null)
  const saveDialogFile = saveDialogFileId ? openFiles.find((f) => f.id === saveDialogFileId) : null
  const pendingEditorCloseQueueRef = useRef<string[]>([])

  // Why: while a save-and-close is awaiting the file to disappear from
  // openFiles, concurrent queueEditorCloseRequests calls (e.g. user clicks X
  // on another dirty tab, or a split-group dispatch fires
  // ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT) must not re-open the dialog over
  // the in-flight save. Track the in-flight file here so
  // getNextQueuedEditorClose can skip it as an un-advanceable head.
  const inFlightSaveFileIdRef = useRef<string | null>(null)

  // Why: after a Save/Discard/Cancel handler dismisses its dialog and advances
  // the queue, a rapid second physical click can land on the freshly-rendered
  // next dialog's button before the user has read the filename — silently
  // discarding or saving work they didn't consciously choose to act on. Gate
  // the three handlers on this ref and release after CLOSE_DIALOG_DEBOUNCE_MS
  // so the stray click from the previous dialog is absorbed while a genuine
  // new click on the next dialog still works.
  const isClosingRef = useRef(false)
  const closeDialogDebounceTimersRef = useRef<Set<number>>(new Set())
  const releaseCloseDialogGuardAfterDebounce = useCallback(() => {
    const timer = window.setTimeout(() => {
      closeDialogDebounceTimersRef.current.delete(timer)
      isClosingRef.current = false
    }, CLOSE_DIALOG_DEBOUNCE_MS)
    closeDialogDebounceTimersRef.current.add(timer)
  }, [])

  // Window close confirmation dialog — shown for local terminals with running
  // child processes. SSH terminals detach/persist through the relay lifecycle.
  const [windowCloseDialogOpen, setWindowCloseDialogOpen] = useState(false)

  // Why: when the main process requests a close while editor tabs are dirty, we
  // must not call confirmWindowClose() until the user saves or discards. The
  // global beforeunload guard still calls preventDefault() while any file is
  // dirty, so an immediate confirm would leave the window open with no UI.
  const windowCloseAfterDirtyRef = useRef<{ isQuitting: boolean } | null>(null)

  const proceedToNativeWindowClose = useCallback((isQuitting: boolean) => {
    // Why: defer this synthetic unload until we are actually ready to close so
    // a dirty-tab preventDefault() does not fire during the initial quit IPC
    // (that path can emit will-prevent-unload and clear isQuitting in main).
    window.dispatchEvent(new Event('beforeunload'))
    if (!isQuitting) {
      const state = useAppStore.getState()
      const localPtyIds = Object.entries(state.tabsByWorktree).flatMap(
        ([worktreeId, worktreeTabs]) => {
          const connectionId = getConnectionId(worktreeId)
          if (connectionId !== null) {
            return []
          }
          return worktreeTabs
            .flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
            .filter((ptyId) => !isRemoteRuntimePtyId(ptyId))
        }
      )
      if (localPtyIds.length > 0) {
        void Promise.all(localPtyIds.map((id) => window.api.pty.hasChildProcesses(id))).then(
          (results) => {
            if (results.some(Boolean)) {
              setWindowCloseDialogOpen(true)
            } else {
              window.api.ui.confirmWindowClose()
            }
          }
        )
        return
      }
    }
    window.api.ui.confirmWindowClose()
  }, [])

  const waitForFileClosed = useCallback((fileId: string, timeoutMs: number): Promise<boolean> => {
    if (!useAppStore.getState().openFiles.some((f) => f.id === fileId)) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      let unsub: (() => void) | null = null
      const timeoutId = window.setTimeout(() => {
        unsub?.()
        resolve(false)
      }, timeoutMs)
      unsub = useAppStore.subscribe((state) => {
        if (!state.openFiles.some((f) => f.id === fileId)) {
          window.clearTimeout(timeoutId)
          unsub?.()
          resolve(true)
        }
      })
      // Why: zustand only fires subscribers on subsequent state changes. If
      // the file closed between the initial guard and subscribe, the
      // transition was missed — re-check synchronously after subscribe.
      if (!useAppStore.getState().openFiles.some((f) => f.id === fileId)) {
        window.clearTimeout(timeoutId)
        unsub?.()
        resolve(true)
      }
    })
  }, [])

  const getNextQueuedEditorClose = useCallback((): string | null => {
    // Why: bulk close actions can enqueue files that become clean or disappear
    // before they reach the front. Drain those entries eagerly so the dialog
    // only blocks on tabs that still require an explicit close decision.
    while (pendingEditorCloseQueueRef.current.length > 0) {
      const fileId = pendingEditorCloseQueueRef.current[0]
      // Why: if a save is still in-flight for this fileId, do not re-open the
      // dialog on top of it. waitForFileClosed will re-advance the queue once
      // the file finishes closing (or the save times out).
      if (inFlightSaveFileIdRef.current === fileId) {
        return null
      }
      const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === fileId)
      if (!file) {
        pendingEditorCloseQueueRef.current.shift()
        continue
      }
      if (!file.isDirty) {
        closeFile(fileId)
        pendingEditorCloseQueueRef.current.shift()
        continue
      }
      return fileId
    }
    return null
  }, [closeFile])

  const advanceEditorCloseQueue = useCallback(() => {
    const nextFileId = getNextQueuedEditorClose()
    if (nextFileId) {
      // Why: the queue can cross worktree boundaries during window-close
      // flows. Switch to the target file's worktree before opening the
      // dialog so the UI behind the dialog matches the filename in it.
      const state = useAppStore.getState()
      const file = state.openFiles.find((f) => f.id === nextFileId)
      if (file && file.worktreeId !== state.activeWorktreeId) {
        setActiveWorktree(file.worktreeId)
      }
      setActiveFile(nextFileId)
      setActiveTabType('editor')
      setSaveDialogFileId(nextFileId)
      return
    }
    setSaveDialogFileId(null)
    const pendingWindowClose = windowCloseAfterDirtyRef.current
    if (pendingWindowClose) {
      windowCloseAfterDirtyRef.current = null
      proceedToNativeWindowClose(pendingWindowClose.isQuitting)
    }
  }, [
    getNextQueuedEditorClose,
    proceedToNativeWindowClose,
    setActiveFile,
    setActiveTabType,
    setActiveWorktree
  ])

  const queueEditorCloseRequests = useCallback(
    (fileIds: string[], pendingWindowClose?: { isQuitting: boolean }) => {
      if (pendingWindowClose) {
        windowCloseAfterDirtyRef.current = pendingWindowClose
      }
      pendingEditorCloseQueueRef.current = appendUniqueOpenFileIds(
        pendingEditorCloseQueueRef.current,
        fileIds,
        new Set(useAppStore.getState().openFiles.map((file) => file.id))
      )
      advanceEditorCloseQueue()
    },
    [advanceEditorCloseQueue]
  )

  const handleCloseFile = useCallback(
    (fileId: string) => {
      const state = useAppStore.getState()
      if (activeWorktreeId && isPinnedActiveEditorTab(state, activeWorktreeId, fileId)) {
        return
      }
      const file = state.openFiles.find((f) => f.id === fileId)
      if (file?.isDirty) {
        queueEditorCloseRequests([fileId])
        return
      }
      closeFile(fileId)
    },
    [activeWorktreeId, closeFile, queueEditorCloseRequests]
  )

  const handleSaveDialogSave = useCallback(async () => {
    if (isClosingRef.current) {
      return
    }
    if (!saveDialogFileId) {
      return
    }
    isClosingRef.current = true
    const fileId = saveDialogFileId
    const file = useAppStore.getState().openFiles.find((f) => f.id === fileId)
    if (!file) {
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (id) => id !== fileId
      )
      advanceEditorCloseQueue()
      releaseCloseDialogGuardAfterDebounce()
      return
    }

    // Why: save-and-close must flush the latest draft even when the visible
    // editor panel has already unmounted. The headless autosave controller
    // owns that write path now, so the dialog signals it through a custom
    // event instead of poking at editor component refs.
    setSaveDialogFileId(null)
    window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId } }))
    inFlightSaveFileIdRef.current = fileId
    let closed = false
    try {
      closed = await waitForFileClosed(fileId, 10_000)
    } finally {
      // Why: clear the in-flight ref regardless of success/timeout so the
      // queue head is no longer treated as un-advanceable by
      // getNextQueuedEditorClose before we re-advance the queue below.
      if (inFlightSaveFileIdRef.current === fileId) {
        inFlightSaveFileIdRef.current = null
      }
    }
    if (!closed) {
      // Why: the save may have resolved in the tiny gap after the timeout
      // fired. Re-check synchronously so we don't re-open a stale dialog
      // for a file that is already gone — drain the queue entry and
      // advance instead. Toast only for the genuine timeout case.
      if (!useAppStore.getState().openFiles.some((f) => f.id === fileId)) {
        pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
          (id) => id !== fileId
        )
        advanceEditorCloseQueue()
        releaseCloseDialogGuardAfterDebounce()
        return
      }
      toast.error('Save timed out or failed. Fix errors before closing.')
      setSaveDialogFileId(fileId)
      // Why: a genuine timeout leaves the user back on the same dialog, so
      // release the guard immediately — a new click here is a deliberate
      // retry, not a stray carry-over from a prior dialog.
      isClosingRef.current = false
      return
    }
    pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
      (id) => id !== fileId
    )
    advanceEditorCloseQueue()
    releaseCloseDialogGuardAfterDebounce()
  }, [
    advanceEditorCloseQueue,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId,
    waitForFileClosed
  ])

  const handleSaveDialogDiscard = useCallback(async () => {
    if (isClosingRef.current) {
      return
    }
    if (!saveDialogFileId) {
      return
    }
    isClosingRef.current = true
    const fileId = saveDialogFileId

    // Why: dismiss the dialog synchronously before awaiting quiesce. A rapid
    // double-click on "Don't Save" would otherwise fire the handler twice
    // with the same captured fileId, causing two concurrent queue advances
    // after the quiesce settles. Mirrors handleSaveDialogSave's early clear.
    setSaveDialogFileId(null)

    // Why: autosave runs on a background timer. Wait for any pending/in-flight
    // write to settle before honoring "Don't Save", otherwise the file can be
    // written after the user explicitly chose to discard their edits.
    try {
      await requestEditorSaveQuiesce({ fileId })
    } catch (error) {
      // Why: quiesce failure must not trap the user in a close dialog loop, but
      // silently swallowing it also hides broken autosave state. Warn so a
      // stuck controller is visible in devtools instead of disappearing.
      console.warn('Autosave quiesce failed before discard', error)
    }
    markFileDirty(fileId, false)
    closeFile(fileId)
    pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
      (id) => id !== fileId
    )
    advanceEditorCloseQueue()
    releaseCloseDialogGuardAfterDebounce()
  }, [
    advanceEditorCloseQueue,
    closeFile,
    markFileDirty,
    releaseCloseDialogGuardAfterDebounce,
    saveDialogFileId
  ])

  const handleSaveDialogCancel = useCallback(() => {
    if (isClosingRef.current) {
      return
    }
    isClosingRef.current = true
    pendingEditorCloseQueueRef.current = []
    windowCloseAfterDirtyRef.current = null
    setSaveDialogFileId(null)
    releaseCloseDialogGuardAfterDebounce()
  }, [releaseCloseDialogGuardAfterDebounce])

  useEffect(() => {
    const onRequestEditorClose = (event: Event): void => {
      const customEvent = event as CustomEvent<EditorRequestFileCloseDetail>
      const fileId = customEvent.detail?.fileId
      if (!fileId) {
        return
      }
      queueEditorCloseRequests([fileId])
    }
    window.addEventListener(
      ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
      onRequestEditorClose as EventListener
    )
    return () =>
      window.removeEventListener(
        ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
        onRequestEditorClose as EventListener
      )
  }, [queueEditorCloseRequests])

  useEffect(() => {
    if (!shouldRepairActiveTerminalTab({ activeTabType, activeTabId, tabs })) {
      return
    }
    // Why: mutating Zustand during render trips React's "Cannot update a
    // component while rendering a different component" warning. Keep the repair
    // terminal-only so inactive CLI-created tabs cannot steal editor/browser focus.
    setActiveTab(tabs[0].id)
    // Why: `tabs` is intentionally the dependency here because the repair must
    // react to tab-order/content changes, not just scalar IDs. The list comes
    // from Zustand selectors and is small in practice, so this explicit repair
    // effect is preferred over duplicating reconciliation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeTabType, setActiveTab, tabs])

  // Track which worktrees have been activated during this app session.
  // Only mount TerminalPanes for visited worktrees to prevent mass PTY
  // spawning when restoring a session with many saved worktree tabs.
  const measurableBackgroundWorktreeTimersRef = useRef(new Map<string, number>())
  const [, setBackgroundMountRevision] = useState(0)
  useEffect(() => {
    const timers = measurableBackgroundWorktreeTimersRef.current
    const closeDialogDebounceTimers = closeDialogDebounceTimersRef.current
    const onBackgroundMountTerminalWorktree = (event: Event): void => {
      const customEvent = event as CustomEvent<BackgroundMountTerminalWorktreeDetail>
      const worktreeId = customEvent.detail?.worktreeId
      addBackgroundMountedTerminalWorktree(mountedWorktreeIdsRef.current, worktreeId, () =>
        setBackgroundMountRevision((revision) => revision + 1)
      )
      if (!worktreeId) {
        return
      }
      measurableBackgroundWorktreeIdsRef.current.add(worktreeId)
      const existingTimer = timers.get(worktreeId)
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer)
      }
      // Why: background renderer-backed terminal creation must be measurable
      // for the first xterm fit, but it must not keep hidden worktrees laid
      // out indefinitely after the PTY has started.
      const timer = window.setTimeout(() => {
        measurableBackgroundWorktreeIdsRef.current.delete(worktreeId)
        timers.delete(worktreeId)
        setBackgroundMountRevision((revision) => revision + 1)
      }, 3000)
      timers.set(worktreeId, timer)
      setBackgroundMountRevision((revision) => revision + 1)
    }
    window.addEventListener(
      BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
      onBackgroundMountTerminalWorktree as EventListener
    )
    return () => {
      window.removeEventListener(
        BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
        onBackgroundMountTerminalWorktree as EventListener
      )
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }
      timers.clear()
      // Why: close-dialog debounce timers are Terminal-owned and only need
      // unmount cleanup; keep them with the existing Terminal lifetime cleanup.
      for (const timer of closeDialogDebounceTimers) {
        window.clearTimeout(timer)
      }
      closeDialogDebounceTimers.clear()
    }
  }, [])
  // Why: gated on workspaceSessionReady to prevent TerminalPane from mounting
  // before reconnectPersistedTerminals() has finished eagerly spawning PTYs.
  // Without this gate, Phase 1 (hydrateWorkspaceSession) sets activeWorktreeId
  // with ptyId: null, and TerminalPane would call connectPanePty → pty:spawn,
  // creating a duplicate PTY for the same tab.
  if (renderedActiveWorktreeId && workspaceSessionReady) {
    mountedWorktreeIdsRef.current.add(renderedActiveWorktreeId)
  }
  // Prune IDs of worktrees that no longer exist (deleted/removed)
  const allWorktreeIds = new Set(allWorktrees.map((wt) => wt.id))
  for (const id of mountedWorktreeIdsRef.current) {
    if (!allWorktreeIds.has(id)) {
      mountedWorktreeIdsRef.current.delete(id)
    }
  }
  const anyMountedWorktreeHasLayout = computeAnyMountedWorktreeHasLayout(
    allWorktrees.map((wt) => wt.id),
    mountedWorktreeIdsRef.current,
    layoutByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree
  )
  // Auto-create first tab when worktree activates
  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }
    if (!activeWorktreeId) {
      return
    }
    // Why: in the paired web client, host session-tabs are authoritative.
    // Creating a local fallback races the host's initial terminal and duplicates tabs.
    if (isWebRuntimeSessionActive(activeRuntimeEnvironmentId)) {
      return
    }

    // Why: this fallback exists to give a newly activated/restored worktree a
    // focusable surface when the reconciled tab model has nothing renderable.
    // Re-running it on ordinary tab-count changes would recreate a terminal
    // immediately after the user intentionally closed the last visible one.
    const { renderableTabCount } = reconcileWorktreeTabModel(activeWorktreeId)
    if (!shouldAutoCreateInitialTerminal(renderableTabCount)) {
      return
    }
    // Why: this tab only exists because the user clicked a never-visited
    // worktree. Tag it so the PTY spawn it triggers does not count as
    // activity and reshuffle the sidebar. Explicit "New Tab" actions
    // (handleNewTab below) still bump normally.
    createTab(activeWorktreeId, undefined, undefined, { pendingActivationSpawn: true })
  }, [
    workspaceSessionReady,
    activeWorktreeId,
    activeRuntimeEnvironmentId,
    createTab,
    reconcileWorktreeTabModel
  ])

  const handleNewTab = useCallback(
    (shellOverride?: string) => {
      if (!activeWorktreeId) {
        return
      }
      const targetGroupId =
        useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
        useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
      if (!shellOverride && targetGroupId) {
        void openNewTerminalTabInActiveWorkspace(targetGroupId)
        return
      }
      if (isWebRuntimeSessionActive(activeRuntimeEnvironmentId)) {
        void createWebRuntimeSessionTerminal({
          worktreeId: activeWorktreeId,
          environmentId: activeRuntimeEnvironmentId,
          command: shellOverride,
          activate: true
        })
        return
      }
      const newTab = createTab(activeWorktreeId, undefined, shellOverride)
      setActiveTabType('terminal')
      // Why: persist the tab bar order with the new terminal at the end of the
      // current visual order. Without this, reconcileOrder falls back to
      // terminals-first when tabBarOrderByWorktree is unset, causing a new
      // terminal to jump to index 0 instead of appending after editor tabs.
      const state = useAppStore.getState()
      const currentTerminals = state.tabsByWorktree[activeWorktreeId] ?? []
      const currentEditors = state.openFiles.filter((f) => f.worktreeId === activeWorktreeId)
      const currentBrowsers = state.browserTabsByWorktree[activeWorktreeId] ?? []
      const stored = state.tabBarOrderByWorktree[activeWorktreeId]
      const termIds = currentTerminals.map((t) => t.id)
      const editorIds = currentEditors.map((f) => f.id)
      const browserIds = currentBrowsers.map((tab) => tab.id)
      const validIds = new Set([...termIds, ...editorIds, ...browserIds])
      const base = (stored ?? []).filter((id) => validIds.has(id))
      const inBase = new Set(base)
      for (const id of [...termIds, ...editorIds, ...browserIds]) {
        if (!inBase.has(id)) {
          base.push(id)
          inBase.add(id)
        }
      }
      // The new tab is already in base via termIds; move it to the end
      const order = base.filter((id) => id !== newTab.id)
      order.push(newTab.id)
      setTabBarOrder(activeWorktreeId, order)
      // Why: shell-specific creation still uses the legacy path; keep the
      // keyboard shortcut focused until the lifted action accepts shell overrides.
      focusTerminalTabSurface(newTab.id)
    },
    [
      activeRuntimeEnvironmentId,
      activeWorktreeId,
      createTab,
      openNewTerminalTabInActiveWorkspace,
      setActiveTabType,
      setTabBarOrder
    ]
  )

  const handleNewBrowserTab = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const targetGroupId =
      useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
      useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
    if (targetGroupId) {
      void openNewBrowserTabInActiveWorkspace(targetGroupId)
      return
    }
    const defaultUrl = useAppStore.getState().browserDefaultUrl ?? 'about:blank'
    if (isWebRuntimeSessionActive(activeRuntimeEnvironmentId)) {
      void createWebRuntimeSessionBrowserTab({
        worktreeId: activeWorktreeId,
        environmentId: activeRuntimeEnvironmentId,
        url: defaultUrl
      })
      return
    }
    createBrowserTab(activeWorktreeId, defaultUrl, {
      title: 'New Browser Tab',
      focusAddressBar: true
    })
  }, [
    activeRuntimeEnvironmentId,
    activeWorktreeId,
    createBrowserTab,
    openNewBrowserTabInActiveWorkspace
  ])

  const handleOpenEntry = useCallback(async (args: TabCreateEntryArgs) => {
    await openTabBarEntry(args)
  }, [])

  const handleDuplicateBrowserTab = useCallback(
    (browserTabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const tabs = state.browserTabsByWorktree[activeWorktreeId] ?? []
      const source = tabs.find((t) => t.id === browserTabId)
      if (!source) {
        return
      }
      if (isWebRuntimeSessionActive(activeRuntimeEnvironmentId)) {
        void createWebRuntimeSessionBrowserTab({
          worktreeId: activeWorktreeId,
          environmentId: activeRuntimeEnvironmentId,
          url: source.url,
          profileId: source.sessionProfileId
        })
        return
      }
      createBrowserTab(activeWorktreeId, source.url, {
        title: source.title,
        sessionProfileId: source.sessionProfileId
      })
    },
    [activeRuntimeEnvironmentId, activeWorktreeId, createBrowserTab]
  )

  const handleNewFile = useCallback(async () => {
    if (!activeWorktreeId) {
      return
    }
    const targetGroupId =
      useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
      useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
    if (!targetGroupId) {
      return
    }
    await openNewMarkdownInActiveWorkspace(targetGroupId)
  }, [activeWorktreeId, openNewMarkdownInActiveWorkspace])

  const handleCloseTab = useCallback((tabId: string) => {
    closeTerminalTab(tabId)
  }, [])

  const handleCloseBrowserTab = useCallback(
    (tabId: string) => {
      const state = useAppStore.getState()
      const owningWorktreeEntry = Object.entries(state.browserTabsByWorktree).find(
        ([, worktreeTabs]) => worktreeTabs.some((tab) => tab.id === tabId)
      )
      const owningWorktreeId = owningWorktreeEntry?.[0] ?? null
      if (!owningWorktreeId) {
        return
      }
      if (isPinnedVisibleTab(state, owningWorktreeId, tabId)) {
        return
      }
      if (isWebRuntimeSessionActive(activeRuntimeEnvironmentId)) {
        void closeWebRuntimeSessionTab({
          worktreeId: owningWorktreeId,
          tabId,
          environmentId: activeRuntimeEnvironmentId
        })
        return
      }
      const currentTabs = state.browserTabsByWorktree[owningWorktreeId] ?? []
      if (currentTabs.length <= 1) {
        destroyWorkspaceWebviews(state.browserPagesByWorkspace, tabId)
        closeBrowserTab(tabId)
        if (state.activeWorktreeId === owningWorktreeId) {
          const worktreeFile = state.openFiles.find((file) => file.worktreeId === owningWorktreeId)
          if (worktreeFile) {
            setActiveFile(worktreeFile.id)
            setActiveTabType('editor')
          } else {
            const terminalTab = (state.tabsByWorktree[owningWorktreeId] ?? [])[0]
            if (terminalTab) {
              setActiveTab(terminalTab.id)
              setActiveTabType('terminal')
            } else {
              setActiveWorktree(null)
            }
          }
        }
        return
      }
      if (state.activeWorktreeId === owningWorktreeId && tabId === state.activeBrowserTabId) {
        const idx = currentTabs.findIndex((tab) => tab.id === tabId)
        const nextTab = currentTabs[idx + 1] ?? currentTabs[idx - 1]
        if (nextTab) {
          setActiveBrowserTab(nextTab.id)
        }
      }
      destroyWorkspaceWebviews(state.browserPagesByWorkspace, tabId)
      closeBrowserTab(tabId)
    },
    [
      activeRuntimeEnvironmentId,
      closeBrowserTab,
      setActiveBrowserTab,
      setActiveFile,
      setActiveTab,
      setActiveTabType,
      setActiveWorktree
    ]
  )

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string) => {
      if (consumeSuppressedPtyExit(ptyId)) {
        return
      }
      handleCloseTab(tabId)
    },
    [consumeSuppressedPtyExit, handleCloseTab]
  )

  const handleCloseOthers = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const order = state.tabBarOrderByWorktree[activeWorktreeId] ?? []
      const dirtyFileIds: string[] = []
      for (const id of order) {
        if (id === tabId) {
          continue
        }
        const unifiedTab = (state.unifiedTabsByWorktree[activeWorktreeId] ?? []).find(
          (candidate) => candidate.id === id || candidate.entityId === id
        )
        if (unifiedTab?.isPinned) {
          continue
        }
        if (
          isWebRuntimeSessionActive(activeRuntimeEnvironmentId) &&
          (unifiedTab?.contentType === 'terminal' || unifiedTab?.contentType === 'browser')
        ) {
          void closeWebRuntimeSessionTab({
            worktreeId: activeWorktreeId,
            tabId: unifiedTab.contentType === 'browser' ? unifiedTab.id : unifiedTab.entityId,
            environmentId: activeRuntimeEnvironmentId
          })
          continue
        }
        if ((state.tabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)) {
          closeTab(id)
        } else if (
          state.openFiles.some((file) => file.worktreeId === activeWorktreeId && file.id === id)
        ) {
          const file = state.openFiles.find((candidate) => candidate.id === id)
          if (file?.isDirty) {
            dirtyFileIds.push(id)
            continue
          }
          closeFile(id)
        } else if (
          (state.browserTabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)
        ) {
          destroyWorkspaceWebviews(state.browserPagesByWorkspace, id)
          closeBrowserTab(id)
        }
      }
      if (dirtyFileIds.length > 0) {
        queueEditorCloseRequests(dirtyFileIds)
      }
    },
    [
      activeRuntimeEnvironmentId,
      activeWorktreeId,
      closeBrowserTab,
      closeFile,
      closeTab,
      queueEditorCloseRequests
    ]
  )

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const currentOrder = state.tabBarOrderByWorktree[activeWorktreeId] ?? []
      const index = currentOrder.findIndex((id) => id === tabId)
      if (index === -1) {
        return
      }
      const rightIds = currentOrder.slice(index + 1)
      const dirtyFileIds: string[] = []
      for (const id of rightIds) {
        const unifiedTab = (state.unifiedTabsByWorktree[activeWorktreeId] ?? []).find(
          (candidate) => candidate.id === id || candidate.entityId === id
        )
        if (unifiedTab?.isPinned) {
          continue
        }
        if (
          isWebRuntimeSessionActive(activeRuntimeEnvironmentId) &&
          (unifiedTab?.contentType === 'terminal' || unifiedTab?.contentType === 'browser')
        ) {
          void closeWebRuntimeSessionTab({
            worktreeId: activeWorktreeId,
            tabId: unifiedTab.contentType === 'browser' ? unifiedTab.id : unifiedTab.entityId,
            environmentId: activeRuntimeEnvironmentId
          })
          continue
        }
        if ((state.tabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)) {
          closeTab(id)
        } else if (
          state.openFiles.some((file) => file.worktreeId === activeWorktreeId && file.id === id)
        ) {
          const file = state.openFiles.find((candidate) => candidate.id === id)
          if (file?.isDirty) {
            dirtyFileIds.push(id)
            continue
          }
          closeFile(id)
        } else if (
          (state.browserTabsByWorktree[activeWorktreeId] ?? []).some((tab) => tab.id === id)
        ) {
          destroyWorkspaceWebviews(state.browserPagesByWorkspace, id)
          closeBrowserTab(id)
        }
      }
      if (dirtyFileIds.length > 0) {
        queueEditorCloseRequests(dirtyFileIds)
      }
    },
    [
      activeRuntimeEnvironmentId,
      activeWorktreeId,
      closeBrowserTab,
      closeFile,
      closeTab,
      queueEditorCloseRequests
    ]
  )

  const handleCloseAllFiles = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const state = useAppStore.getState()
    const filesInWorktree = state.openFiles.filter((file) => file.worktreeId === activeWorktreeId)
    const closableFiles = filesInWorktree.filter(
      (file) => !isPinnedEditorFileTab(state, activeWorktreeId, file.id)
    )
    const dirtyFileIds = closableFiles.filter((file) => file.isDirty).map((file) => file.id)
    for (const file of closableFiles) {
      if (!file.isDirty) {
        closeFile(file.id)
      }
    }
    if (dirtyFileIds.length > 0) {
      queueEditorCloseRequests(dirtyFileIds)
    }
  }, [activeWorktreeId, closeFile, queueEditorCloseRequests])

  const handleActivateTab = useCallback(
    (tabId: string) => {
      if (activeWorktreeId && isWebRuntimeSessionActive(activeRuntimeEnvironmentId)) {
        void activateWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId,
          environmentId: activeRuntimeEnvironmentId
        })
      }
      setActiveTab(tabId)
      setActiveTabType('terminal')
    },
    [activeRuntimeEnvironmentId, activeWorktreeId, setActiveTab, setActiveTabType]
  )

  const handleTogglePaneExpand = useCallback(
    (tabId: string) => {
      setActiveTab(tabId)
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
            detail: { tabId }
          })
        )
      })
    },
    [setActiveTab]
  )

  const handleActivateBrowserTab = useCallback(
    (tabId: string) => {
      if (activeWorktreeId && isWebRuntimeSessionActive(activeRuntimeEnvironmentId)) {
        void activateWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId,
          environmentId: activeRuntimeEnvironmentId
        })
      }
      setActiveBrowserTab(tabId)
      setActiveTabType('browser')
    },
    [activeRuntimeEnvironmentId, activeWorktreeId, setActiveBrowserTab, setActiveTabType]
  )

  // Keyboard shortcuts
  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const shortcutPlatform: NodeJS.Platform = isMac
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'
    const onKeyDown = (e: KeyboardEvent): void => {
      const context = getKeybindingContext(e.target)
      const floatingWorkspaceFocused = isFloatingWorkspacePanelFocused()
      const matchShortcut = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, e, shortcutPlatform, keybindings, {
          context,
          terminalShortcutPolicy
        })
      const notifyTerminalCapture = (actionId: KeybindingActionId): void => {
        if (context !== 'terminal' || terminalShortcutPolicy !== 'orca-first') {
          return
        }
        showTerminalShortcutCaptureNotification({
          actionId,
          platform: shortcutPlatform,
          keybindings
        })
      }
      // Why: Cmd/Ctrl+T always opens a new terminal, regardless of which
      // surface is active. Browser-tab creation has its own shortcut
      // (Cmd/Ctrl+Shift+B) so users have a predictable way to spawn a
      // terminal from anywhere in the central pane.
      if (!e.repeat && matchShortcut('tab.newTerminal')) {
        e.preventDefault()
        notifyTerminalCapture('tab.newTerminal')
        if (floatingWorkspaceFocused) {
          void createFloatingWorkspaceTerminalTab(useAppStore.getState())
          return
        }
        handleNewTab()
        return
      }

      // Cmd/Ctrl+Shift+T — reopen closed browser tab when browser is active,
      // otherwise reopen the most recently closed editor tab.
      if (!e.repeat && matchShortcut('tab.reopenClosed')) {
        e.preventDefault()
        notifyTerminalCapture('tab.reopenClosed')
        const state = useAppStore.getState()
        if (state.activeTabType === 'browser') {
          const restored = state.reopenClosedBrowserTab(activeWorktreeId)
          if (restored === null) {
            state.reopenClosedEditorTab(activeWorktreeId)
          }
        } else {
          state.reopenClosedEditorTab(activeWorktreeId)
        }
        return
      }

      // Cmd/Ctrl+Shift+B - new browser tab
      if (!e.repeat && matchShortcut('tab.newBrowser')) {
        e.preventDefault()
        notifyTerminalCapture('tab.newBrowser')
        if (floatingWorkspaceFocused) {
          void createFloatingWorkspaceBrowserTab(useAppStore.getState())
          return
        }
        handleNewBrowserTab()
        return
      }

      // Save active editor file (fallback for when focus is
      // outside the editor content area, e.g. on the tab bar or sidebar).
      // When the editor itself has focus, editor-local handlers own the save
      // shortcut, so we skip this when the target is editable.
      if (!e.repeat && matchShortcut('editor.save')) {
        const target = e.target as HTMLElement | null
        const inEditor =
          target?.closest('.monaco-editor, [contenteditable]') !== null ||
          target?.closest('textarea:not(.xterm-helper-textarea), input') !== null
        if (!inEditor) {
          const state = useAppStore.getState()
          if (state.activeTabType === 'editor' && state.activeFileId) {
            e.preventDefault()
            notifyTerminalCapture('editor.save')
            window.dispatchEvent(new Event(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT))
            return
          }
        }
      }

      // Cmd/Ctrl+Shift+M - new markdown file
      if (!e.repeat && matchShortcut('tab.newMarkdown')) {
        e.preventDefault()
        notifyTerminalCapture('tab.newMarkdown')
        if (floatingWorkspaceFocused) {
          void createFloatingWorkspaceMarkdownTab(useAppStore.getState()).catch((err) => {
            toast.error(
              err instanceof Error ? err.message : 'Failed to create untitled markdown file.'
            )
          })
          return
        }
        void handleNewFile()
        return
      }

      if (handleEmptyFloatingWorkspacePanelCloseShortcut(e, shortcutPlatform, keybindings)) {
        return
      }

      // Cmd/Ctrl+W - close active editor tab, browser tab, or terminal pane.
      // Terminal pane/tab close is handled by the pane-level keyboard handler
      // in keyboard-handlers.ts so it can close individual split panes and
      // show a confirmation dialog. We still preventDefault here so Electron
      // doesn't close the window as its default Cmd+W action.
      if (!e.repeat && matchShortcut('tab.close')) {
        const state = useAppStore.getState()
        if (state.activeTabType === 'terminal' && context === 'terminal') {
          return
        }
        e.preventDefault()
        notifyTerminalCapture('tab.close')
        if (state.activeTabType === 'editor' && state.activeFileId) {
          handleCloseFile(state.activeFileId)
        } else if (state.activeTabType === 'browser' && state.activeBrowserTabId) {
          handleCloseBrowserTab(state.activeBrowserTabId)
        }
        return
      }

      // Ctrl+Tab - quick-toggle to the previously focused tab in this group.
      if (
        matchesRecentTabSwitcherChord(e, shortcutPlatform, keybindings, {
          context,
          terminalShortcutPolicy
        })
      ) {
        return
      }
      if (!e.repeat && matchShortcut('tab.previousRecent')) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        handleSwitchRecentTab()
        return
      }

      // Cmd/Ctrl+Shift+] and Cmd/Ctrl+Shift+[ - switch tabs (scoped to the
      // active tab type). Cmd/Ctrl+Alt+] and Cmd/Ctrl+Alt+[ cycles across
      // every tab type as an escape hatch from the type-scoped default, and
      // matches the platform tab-switch chord on macOS.
      // Why: use e.code instead of e.key because on macOS, Shift+[ reports '{'
      // as the key value (the shifted character), not '['. Option+[ also
      // composes to dead-key / punctuation on many layouts, so matching on
      // event.key would miss the chord entirely on non-US layouts.
      const switchSameTypeDirection = matchShortcut('tab.nextSameType')
        ? 1
        : matchShortcut('tab.previousSameType')
          ? -1
          : null
      const switchAllTypesDirection = matchShortcut('tab.nextAllTypes')
        ? 1
        : matchShortcut('tab.previousAllTypes')
          ? -1
          : null
      if (!e.repeat && (switchSameTypeDirection !== null || switchAllTypesDirection !== null)) {
        // Why: delegate to the shared handler used by the IPC shortcut path
        // so both code paths share one implementation. Always consume the
        // chord — even when the switch is a no-op (e.g. single tab), we own
        // this key combo and shouldn't let it reach xterm or the browser
        // guest's default handling.
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        notifyTerminalCapture(
          switchAllTypesDirection !== null
            ? switchAllTypesDirection === 1
              ? 'tab.nextAllTypes'
              : 'tab.previousAllTypes'
            : switchSameTypeDirection === 1
              ? 'tab.nextSameType'
              : 'tab.previousSameType'
        )
        if (floatingWorkspaceFocused) {
          switchFloatingWorkspaceTab(
            useAppStore.getState(),
            switchAllTypesDirection ?? switchSameTypeDirection ?? 1,
            switchAllTypesDirection !== null ? 'all-types' : 'same-type'
          )
        } else if (switchAllTypesDirection !== null) {
          handleSwitchTabAcrossAllTypes(switchAllTypesDirection)
        } else {
          handleSwitchTab(switchSameTypeDirection ?? 1)
        }
      }

      // Ctrl+PageDown/PageUp - switch terminal tabs only
      // Why: this chord intentionally uses Ctrl on every platform; on macOS,
      // Cmd+PageUp/PageDown is an OS desktop-switch shortcut we should not steal.
      // Why: also reject Shift so Ctrl+Shift+PageUp/PageDown stays available
      // for focused terminal / editor consumers and matches the unshifted
      // predicate in browser-guest-ui.ts and the chord advertised in
      // ShortcutsPane.
      const terminalTabDirection = matchShortcut('tab.nextTerminal')
        ? 1
        : matchShortcut('tab.previousTerminal')
          ? -1
          : null
      if (!e.repeat && terminalTabDirection !== null) {
        // Why: always consume the chord before xterm's textarea listener
        // sees it, regardless of whether we actually switched tabs. xterm
        // translates plain Ctrl+PageUp/PageDown into \e[5~ / \e[6~ escape
        // sequences and writes them to the shell; that stray output then
        // also flips the tab's unread/bell indicator. In the single-terminal
        // case handleSwitchTerminalTab is a no-op, but we still need to
        // swallow the event — otherwise pressing the chord on the only
        // terminal leaves "5~" in the shell and lights up a phantom
        // notification on the tab that already has focus. preventDefault
        // alone does not stop xterm's own keydown listener, so we also
        // stop propagation.
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        if (floatingWorkspaceFocused) {
          switchFloatingWorkspaceTab(useAppStore.getState(), terminalTabDirection, 'terminal')
        } else {
          handleSwitchTerminalTab(terminalTabDirection)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeWorktreeId,
    handleNewBrowserTab,
    handleNewFile,
    handleNewTab,
    handleCloseTab,
    handleCloseBrowserTab,
    closeBrowserTab,
    handleCloseFile,
    keybindings,
    terminalShortcutPolicy
  ])

  // Warn on window close if there are unsaved editor files
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      // Why: update/manual restarts pre-save dirty tabs and then intentionally
      // close the app. Do not let stale dirty flags veto the relaunch path.
      if (isIntentionalAppRestartInProgress()) {
        return
      }
      const dirtyFiles = useAppStore.getState().openFiles.filter((f) => f.isDirty)
      if (dirtyFiles.length > 0) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Listen for main-process window close requests. Terminal sessions are
  // detached by the daemon/SSH lifecycle; only dirty editor files should block
  // close here. Explicit destructive terminal actions keep their own confirms.
  useEffect(() => {
    return window.api.ui.onWindowCloseRequested(({ isQuitting }) => {
      if (isIntentionalAppRestartInProgress()) {
        window.api.ui.confirmWindowClose()
        return
      }

      // Why: if a previous close request is already being handled (user is
      // working through dirty-file dialogs), ignore duplicate quit signals
      // to avoid overwriting the in-flight ref and losing the close sequence.
      if (windowCloseAfterDirtyRef.current) {
        return
      }

      const dirtyFiles = useAppStore.getState().openFiles.filter((f) => f.isDirty)
      if (dirtyFiles.length > 0) {
        queueEditorCloseRequests(
          dirtyFiles.map((file) => file.id),
          { isQuitting }
        )
        return
      }

      proceedToNativeWindowClose(isQuitting)
    })
  }, [proceedToNativeWindowClose, queueEditorCloseRequests])

  // Why: browser page state can disappear through store-only paths (CLI tab
  // close, worktree deletion). The store cannot call destroyPersistentWebview
  // because that function owns renderer DOM nodes, so this subscriber tears down
  // webviews whose backing page records were removed.
  const prevBrowserWebviewIdsRef = useRef<Set<string>>(
    collectBrowserWebviewIds(
      useAppStore.getState().browserTabsByWorktree,
      useAppStore.getState().browserPagesByWorkspace
    )
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

  // Why: defensive guard against state inconsistency. If activeTabType is
  // 'browser' but no browser tab can be rendered (e.g. activeBrowserTabId is
  // null or doesn't match any tab), fall back to terminal view instead of
  // rendering a blank screen. This runs as an effect (not during render)
  // because calling Zustand mutations during render interferes with React's
  // render cycle and causes blank screens when creating new tabs.
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

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${renderedActiveWorktreeId ? '' : ' hidden'}`}
      data-rendered-active-worktree-id={renderedActiveWorktreeId ?? undefined}
    >
      <EditorAutosaveController />

      {/* Why: once split groups are enabled, each group owns its own tab strip
          inline. The old titlebar portal stays only as a fallback
          before the root-group layout has been established. */}
      {renderedActiveWorktreeId &&
        !effectiveActiveLayout &&
        titlebarTabsTarget &&
        createPortal(
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            worktreeId={renderedActiveWorktreeId}
            onActivate={handleActivateTab}
            onClose={handleCloseTab}
            onCloseOthers={handleCloseOthers}
            onCloseToRight={handleCloseTabsToRight}
            onNewTerminalTab={() => handleNewTab()}
            onNewTerminalWithShell={handleNewTab}
            onNewBrowserTab={handleNewBrowserTab}
            onOpenEntry={handleOpenEntry}
            onNewFileTab={handleNewFile}
            onSetCustomTitle={setTabCustomTitle}
            onSetTabColor={setTabColor}
            expandedPaneByTabId={expandedPaneByTabId}
            onTogglePaneExpand={handleTogglePaneExpand}
            editorFiles={worktreeFiles}
            browserTabs={worktreeBrowserTabs}
            activeFileId={activeFileId}
            activeBrowserTabId={activeBrowserTabId}
            activeTabType={activeTabType}
            onActivateFile={(fileId) => {
              setActiveFile(fileId)
              setActiveTabType('editor')
            }}
            onCloseFile={handleCloseFile}
            onActivateBrowserTab={handleActivateBrowserTab}
            onCloseBrowserTab={handleCloseBrowserTab}
            onDuplicateBrowserTab={handleDuplicateBrowserTab}
            onCloseAllFiles={handleCloseAllFiles}
            onMakePreviewFilePermanent={makePreviewFilePermanent}
            onPinFile={pinFile}
            tabBarOrder={tabBarOrder}
          />,
          titlebarTabsTarget
        )}

      {/* Why: the full-width titlebar is no longer rendered in workspace view
          — tab groups + terminal extend to the top of the window instead.
          The old summary label (workspace / active surface) is removed. */}

      {anyMountedWorktreeHasLayout ? (
        <div
          className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${effectiveActiveLayout ? '' : ' hidden'}`}
        >
          {/* Why: each mounted worktree surface is absolutely positioned so we
              can preserve hidden trees without reflowing the active one. Keep
              a relative anchor here so those panes size to the workspace body
              rather than some outer ancestor when split groups are enabled. */}
          {allWorktrees
            .filter((wt) => mountedWorktreeIdsRef.current.has(wt.id))
            .map((worktree) => {
              const layout = getEffectiveLayoutForWorktree(worktree.id)
              if (!layout) {
                return null
              }
              // Why: use strict equality with 'terminal' instead of !== 'settings'
              // so the terminal/browser surface hides on the tasks page too.
              const isVisible =
                activeView === 'terminal' && worktree.id === renderedActiveWorktreeId
              const shouldMeasureHiddenWorktree =
                !isVisible && measurableBackgroundWorktreeIdsRef.current.has(worktree.id)
              return (
                <WorktreeSplitSurface
                  key={`tab-groups-${worktree.id}`}
                  worktreeId={worktree.id}
                  worktreePath={worktree.path}
                  layout={layout}
                  focusedGroupId={activeGroupIdByWorktree[worktree.id]}
                  isVisible={isVisible}
                  shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
                  activityTerminalPortals={activityTerminalPortals}
                />
              )
            })}
        </div>
      ) : null}

      {!effectiveActiveLayout && !anyMountedWorktreeHasLayout && (
        <>
          {/* Why: split-group layouts render their own terminal/browser/editor
              surfaces through TabGroupPanel plus stable overlay layers.
              Keeping the legacy workspace-level panes mounted underneath
              as hidden DOM creates duplicate
              TerminalPane/BrowserPane instances for the same tab, which lets
              two React trees race over one PTY or webview. Render only one
              surface model at a time.

              Also gate on !anyMountedWorktreeHasLayout: when the active
              worktree goes null (e.g. during shutdown-from-focused, which
              calls setActiveWorktree(null) before shutdownWorktreeTerminals)
              effectiveActiveLayout becomes undefined but other mounted
              worktrees still have layouts. Without this guard, the legacy
              branch mounts fresh TerminalPanes for every worktree in
              mountedWorktreeIdsRef, each running connectPanePty →
              startFreshSpawn → new PTY. That respawn is exactly what flips
              getWorktreeStatus back to 'active' and re-lights the sidebar
              dot green moments after the user clicked Shutdown. */}
          {/* Terminal panes container - hidden when editor tab active */}
          <div
            className={`relative flex-1 min-h-0 overflow-hidden ${
              // Why: only hide the terminal container when another tab type has
              // content to display. Hiding unconditionally for non-terminal types
              // causes a blank screen when activeTabType is stale (e.g. 'editor'
              // with no files after session restore). The terminal stays visible
              // as a fallback until another surface is ready.
              (activeTabType === 'editor' && worktreeFiles.length > 0) ||
              (activeTabType === 'browser' && worktreeBrowserTabs.length > 0)
                ? 'hidden'
                : ''
            }`}
          >
            {allWorktrees
              .filter((wt) => mountedWorktreeIdsRef.current.has(wt.id))
              .map((worktree) => {
                // Why: use strict equality with 'terminal' instead of !== 'settings'
                // so the terminal/browser surface hides on the tasks page too.
                const isVisible =
                  activeView === 'terminal' && worktree.id === renderedActiveWorktreeId
                const shouldMeasureHiddenWorktree =
                  !isVisible && measurableBackgroundWorktreeIdsRef.current.has(worktree.id)
                return (
                  <div
                    key={worktree.id}
                    className={
                      isVisible
                        ? 'absolute inset-0'
                        : shouldMeasureHiddenWorktree
                          ? 'absolute inset-0 opacity-0 pointer-events-none'
                          : 'absolute inset-0 hidden'
                    }
                    aria-hidden={!isVisible}
                  >
                    <CodexRestartChip worktreeId={worktree.id} />
                    {(tabsByWorktree[worktree.id] ?? []).map((tab) => {
                      const activityTerminalPortal = findActivityTerminalPortal(
                        activityTerminalPortals,
                        { worktreeId: worktree.id, tabId: tab.id }
                      )
                      const isActivityPortalTab = activityTerminalPortal !== null
                      const isActiveTerminalTab =
                        isVisible && tab.id === activeTabId && activeTabType === 'terminal'
                      const terminalPane = (
                        <TerminalPane
                          key={`${tab.id}-${tab.generation ?? 0}`}
                          tabId={tab.id}
                          worktreeId={worktree.id}
                          cwd={worktree.path}
                          isActive={isActiveTerminalTab || activityTerminalPortal?.active === true}
                          // Why: the activity page hosts this existing pane via
                          // portal while the workspace surface remains hidden.
                          // Keeping `isVisible` true for the portaled tab lets
                          // xterm fit and stream foreground output in-place.
                          isVisible={isActiveTerminalTab || isActivityPortalTab}
                          // Why: when portaled to Activity for a specific agent
                          // pane, isolate that leaf so split siblings stay
                          // hidden. Workspace renders pass null → no override.
                          isolatedPaneKey={activityTerminalPortal?.paneKey ?? null}
                          onPtyExit={(ptyId) => handlePtyExit(tab.id, ptyId)}
                          onCloseTab={() => handleCloseTab(tab.id)}
                        />
                      )
                      if (activityTerminalPortal) {
                        return createPortal(
                          terminalPane,
                          activityTerminalPortal.target,
                          `activity-terminal-${tab.id}`
                        )
                      }
                      return terminalPane
                    })}
                  </div>
                )
              })}
          </div>

          {/* Browser panes container — only the active pane mounts so inactive
              webviews park into the bounded registry instead of keeping hidden
              Electron guest renderers alive indefinitely. */}
          <div
            className={`relative flex-1 min-h-0 overflow-hidden ${
              activeTabType !== 'browser' ? 'hidden' : ''
            }`}
          >
            {allWorktrees.map((worktree) => {
              const browserTabs = browserTabsByWorktree[worktree.id] ?? []
              // Why: use strict equality with 'terminal' instead of !== 'settings'
              // so browser panes also hide on the tasks page.
              const isVisibleWorktree =
                activeView === 'terminal' && worktree.id === renderedActiveWorktreeId
              if (browserTabs.length === 0) {
                return null
              }
              return (
                <div
                  key={`browser-${worktree.id}`}
                  className={isVisibleWorktree ? 'absolute inset-0' : 'absolute inset-0 hidden'}
                  aria-hidden={!isVisibleWorktree}
                >
                  {browserTabs.map((browserTab) => {
                    const isBrowserActive =
                      isVisibleWorktree &&
                      activeTabType === 'browser' &&
                      browserTab.id === activeBrowserTabId
                    return (
                      <div
                        key={browserTab.id}
                        className={`absolute inset-0${isBrowserActive ? '' : ' pointer-events-none hidden'}`}
                      >
                        {isBrowserActive ? (
                          <BrowserPane browserTab={browserTab} isActive={isBrowserActive} />
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {renderedActiveWorktreeId && activeTabType === 'editor' && worktreeFiles.length > 0 && (
            <Suspense
              fallback={
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                  Loading editor...
                </div>
              }
            >
              <EditorPanel />
            </Suspense>
          )}
        </>
      )}

      {/* Save confirmation dialog */}
      <Dialog
        open={saveDialogFileId !== null}
        onOpenChange={(open) => {
          if (!open) {
            handleSaveDialogCancel()
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Unsaved Changes</DialogTitle>
            <DialogDescription className="text-xs">
              {saveDialogFile
                ? `"${basename(saveDialogFile.relativePath)}" has unsaved changes. Do you want to save before closing?`
                : 'This file has unsaved changes.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogCancel}>
              Cancel
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogDiscard}>
              Don&apos;t Save
            </Button>
            <Button type="button" size="sm" onClick={handleSaveDialogSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Window close confirmation dialog */}
      <Dialog
        open={windowCloseDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setWindowCloseDialogOpen(false)
          }
        }}
      >
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">Close Window?</DialogTitle>
            <DialogDescription className="text-xs">
              There are local terminals with running processes. Close the window anyway?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setWindowCloseDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              autoFocus
              onClick={() => {
                setWindowCloseDialogOpen(false)
                window.api.ui.confirmWindowClose()
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Why: each TabGroupPanel tags its body element with an `anchor-name`, and
// worktree-level overlay layers render every terminal/browser tab once —
// keyed by pane id only — then pin each pane to the owning group's anchor via
// CSS `position-anchor`. Moving a tab between groups now only changes which
// anchor-name the overlay references, so terminals do not remount and
// webviews do not reparent/reload.
//
// Why `React.memo`: Terminal.tsx has many store subscriptions and re-renders
// on unrelated updates (terminal keystrokes, editor edits, focus changes).
// Without memoization, every Terminal re-render would cascade into
// BrowserPaneOverlayLayer and its BrowserPane subtrees. Memoizing here means
// the surface only re-renders when its own props (worktreeId / layout /
// focusedGroupId / isVisible) actually change.
const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  shouldMeasureHiddenWorktree,
  activityTerminalPortals
}: {
  worktreeId: string
  worktreePath: string
  layout: TabGroupLayoutNode
  focusedGroupId?: string
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
}): React.JSX.Element {
  const browserPageIds = useAppStore(
    useShallow((state) =>
      (state.browserTabsByWorktree[worktreeId] ?? []).flatMap((tab) =>
        tab.pageIds && tab.pageIds.length > 0 ? tab.pageIds : [tab.activePageId ?? tab.id]
      )
    )
  )
  const hasAutomationVisibleBrowser = useBrowserAutomationVisibilityForAny(browserPageIds)
  const shouldKeepPaintable = shouldMeasureHiddenWorktree || hasAutomationVisibleBrowser

  return (
    <div
      className={
        isVisible
          ? 'absolute inset-0 flex'
          : shouldKeepPaintable
            ? 'absolute inset-0 flex opacity-0 pointer-events-none'
            : 'absolute inset-0 hidden'
      }
      // Why: automation-visible panes must stay paintable for webviews, but
      // invisible controls cannot remain reachable by Tab or assistive tech.
      inert={!isVisible}
      aria-hidden={!isVisible}
    >
      <CodexRestartChip worktreeId={worktreeId} />
      <TabGroupSplitLayout
        layout={layout}
        worktreeId={worktreeId}
        focusedGroupId={focusedGroupId}
        isWorktreeActive={isVisible}
      />
      <TerminalPaneOverlayLayer
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isWorktreeActive={isVisible}
        activityTerminalPortals={activityTerminalPortals}
      />
      <BrowserPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isVisible} />
    </div>
  )
})

export default React.memo(Terminal)
