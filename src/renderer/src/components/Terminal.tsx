/* eslint-disable max-lines */

import React, { useEffect, useCallback, useMemo, useRef, useState, Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  TOGGLE_TERMINAL_PANE_EXPAND_EVENT,
  type BackgroundMountTerminalWorktreeDetail
} from '@/constants/terminal'
import { useAppStore } from '../store'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
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
import type { Tab, TabContentType, TabGroupLayoutNode, TuiAgent } from '../../../shared/types'
import { hasFeatureInteraction } from '../../../shared/feature-interactions'
import BrowserPane from './browser-pane/BrowserPane'
import BrowserPaneOverlayLayer from './browser-pane/BrowserPaneOverlayLayer'
import EmulatorPaneOverlayLayer from './emulator-pane/EmulatorPaneOverlayLayer'
import { useBrowserAutomationVisibilityForAny } from './browser-pane/browser-automation-visibility'
import { useBrowserMobileDriverForAny } from '@/lib/pane-manager/browser-mobile-driver-state'
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
import AiVaultSessionDropLayer from './tab-group/AiVaultSessionDropLayer'
import { shouldAutoCreateInitialTerminal } from './terminal/initial-terminal'
import { resolveRepairedActiveTerminalTabId } from './terminal/active-terminal-repair'
import { scheduleBackgroundTerminalWorktreeMeasure } from './terminal/background-terminal-worktree-visibility'
import {
  applyBackgroundMountTabRestriction,
  canDeferColdActivationTabsForHost,
  planColdActivationTabDeferral,
  pruneClosedBackgroundMountTabs,
  revealActivationDeferredTabs,
  shouldMountBackgroundWorktreeTab,
  takeAllPendingBackgroundTerminalWorktreeMounts,
  takePendingBackgroundTerminalWorktreeMount
} from './terminal/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '../runtime/sync-runtime-graph'
import {
  getEffectiveLayoutForWorktree as getEffectiveLayout,
  anyMountedWorktreeHasLayout as computeAnyMountedWorktreeHasLayout
} from './terminal/split-group-mount'
import { buildDuplicatedBrowserTabOptions } from '@/lib/duplicate-browser-tab-options'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { setForegroundTerminalTabIds } from '@/lib/foreground-terminal-tabs'
import {
  getTerminalWorktreeColdParkRecheckDelayMs,
  selectColdParkedTerminalWorktrees,
  type TerminalWorktreeColdParkCandidate
} from './terminal-pane/terminal-hidden-view-parking'
import { getTerminalParkingPolicyOverrides } from './terminal-pane/terminal-parking-e2e-overrides'
import {
  canWatcherCoverParkedTerminalTab,
  disposeAllParkedTerminalWatchers,
  pruneParkedTerminalWatchers,
  shouldDeferParkedPtyExitTabClose,
  syncParkedTerminalTabWatchers
} from './terminal-pane/terminal-parked-tab-watchers'
import { isMainTerminalSideEffectAuthorityForPty } from './terminal-pane/terminal-side-effect-facts-handler'
import { appendUniqueOpenFileIds } from './terminal/unsaved-close-queue'
import { setWindowCloseRequestHandler } from './window-close-request-coordinator'
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
import { openMobileEmulatorTab } from '@/lib/open-mobile-emulator-tab'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import { listBoundAgentTabActions, resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
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
import { translate } from '@/i18n/i18n'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'

const EditorPanel = lazy(() => import('./editor/EditorPanel'))

// Why: after a close-dialog handler advances the queue and renders the next
// dialog, gate new handler runs for this long so a stray carry-over click
// from the prior dialog can't silently act on the new one. Short enough to
// feel responsive on a deliberate follow-up click; long enough to absorb the
// trailing edge of a physical double-click (~150 ms on most hardware).
const CLOSE_DIALOG_DEBOUNCE_MS = 200
const EDITOR_TAB_CONTENT_TYPES = new Set<TabContentType>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

type TerminalStoreSnapshot = ReturnType<typeof useAppStore.getState>

function haveSameWorktreeIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false
    }
  }
  return true
}

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

function getActiveWorktreeRuntimeEnvironmentId(worktreeId: string | null): string | null {
  return getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)
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
  const terminalWorktreeHiddenSinceRef = useRef(new Map<string, number>())
  const terminalWorktreeParkingTimersRef = useRef(new Map<string, number>())
  const allWorktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const workspaceSurfaces = useMemo(
    () => [
      ...allWorktrees.map((worktree) => ({ id: worktree.id, path: worktree.path })),
      ...folderWorkspaces.map((workspace) => ({
        id: folderWorkspaceKey(workspace.id),
        path: workspace.folderPath
      }))
    ],
    [allWorktrees, folderWorkspaces]
  )
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const renderedActiveWorktreeId = activeWorktreeId
  const activeWorktreeDeferralHostId = useAppStore((s) =>
    getResolvedExecutionHostIdForWorktree(s, renderedActiveWorktreeId)
  )
  const activeView = useAppStore((s) => s.activeView)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const pendingStartupByTabId = useAppStore((s) => s.pendingStartupByTabId)
  const terminalParkingEnabled = useAppStore((s) => s.settings?.terminalHiddenViewParking !== false)
  const terminalTitleSnapshotAuthorityEnabled = useAppStore((s) =>
    isMainTerminalSideEffectAuthorityForPty({
      settings: s.settings,
      runtimeEnvironmentId: null
    })
  )
  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeTabIdByWorktree = useAppStore((s) => s.activeTabIdByWorktree)
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const consumeSuppressedPtyExit = useAppStore((s) => s.consumeSuppressedPtyExit)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const hydrationSucceeded = useAppStore((s) => s.hydrationSucceeded)
  const openFiles = useAppStore((s) => s.openFiles)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const activeBrowserTabId = useAppStore((s) => s.activeBrowserTabId)
  const activeTabType = useAppStore((s) => s.activeTabType)
  const keybindings = useAppStore((s) => s.keybindings)
  const terminalShortcutPolicy = useAppStore(
    (s) => s.settings?.terminalShortcutPolicy ?? 'orca-first'
  )
  const mobileEmulatorEnabled = useAppStore((s) => s.settings?.mobileEmulatorEnabled !== false)
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
  const foregroundTerminalTabIds = useMemo(() => {
    const ids = new Set<string>()
    if (activeView === 'terminal' && activeTabType === 'terminal' && activeTabId) {
      ids.add(activeTabId)
    }
    for (const portal of activityTerminalPortals) {
      ids.add(portal.tabId)
    }
    return Array.from(ids)
  }, [activeTabId, activeTabType, activeView, activityTerminalPortals])

  useEffect(() => {
    // Why: hibernation must treat terminals portaled into foreground surfaces
    // as visible even when they are not the singular active terminal tab.
    setForegroundTerminalTabIds(foregroundTerminalTabIds)
    return () => setForegroundTerminalTabIds([])
  }, [foregroundTerminalTabIds])

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
      toast.error(
        translate(
          'auto.components.Terminal.a2a279b32a',
          'Save timed out or failed. Fix errors before closing.'
        )
      )
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
    const rememberedTabId = renderedActiveWorktreeId
      ? (activeTabIdByWorktree[renderedActiveWorktreeId] ?? null)
      : null
    // Why: prefer the worktree's remembered active tab over the first tab so a
    // repair firing on a transient worktree-switch render restores the tab the
    // user left on instead of permanently resetting the selection to Terminal 1.
    const repairedTabId = resolveRepairedActiveTerminalTabId({
      activeTabType,
      activeTabId,
      rememberedTabId,
      tabs
    })
    if (!repairedTabId) {
      return
    }
    // Why: mutating Zustand during render trips React's "Cannot update a
    // component while rendering a different component" warning. Keep the repair
    // terminal-only so inactive CLI-created tabs cannot steal editor/browser focus.
    setActiveTab(repairedTabId)
    // Why: `tabs` is intentionally the dependency here because the repair must
    // react to tab-order/content changes, not just scalar IDs. The list comes
    // from Zustand selectors and is small in practice, so this explicit repair
    // effect is preferred over duplicating reconciliation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTabId,
    activeTabType,
    setActiveTab,
    tabs,
    activeTabIdByWorktree,
    renderedActiveWorktreeId
  ])

  // Track which worktrees have been activated during this app session.
  // Only mount TerminalPanes for visited worktrees to prevent mass PTY
  // spawning when restoring a session with many saved worktree tabs.
  const measurableBackgroundWorktreeTimersRef = useRef(new Map<string, number>())
  const [backgroundMountRevision, setBackgroundMountRevision] = useState(0)
  const [terminalParkingRevision, setTerminalParkingRevision] = useState(0)
  const [parkedTerminalWorktreeIds, setParkedTerminalWorktreeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Why: background-mounted worktrees restricted to specific tabs (targeted
  // wake/resume) must not instantiate a TerminalPane per saved tab. A worktree
  // absent from this map mounts all of its tabs.
  const backgroundMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  // Why: targeted background mounts share the allowed-tab map above, but only
  // cold activation deferral should immediately create watcher coverage for
  // every unmounted tab.
  const activationDeferredMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  // Why: the cold-activation deferral decision must run once per activation
  // transition, not on every re-render of an already-active worktree.
  const lastActivationWorktreeIdRef = useRef<string | null>(null)
  useEffect(() => {
    const timers = measurableBackgroundWorktreeTimersRef.current
    const closeDialogDebounceTimers = closeDialogDebounceTimersRef.current
    const applyBackgroundMount = (detail: BackgroundMountTerminalWorktreeDetail): void => {
      const worktreeId = detail.worktreeId
      applyBackgroundMountTabRestriction(
        backgroundMountTabIdsByWorktreeRef.current,
        mountedWorktreeIdsRef.current,
        worktreeId,
        detail.tabIds
      )
      // Why: a targeted wake can reveal a tab that was deferred by an earlier
      // user activation. Remove it from watcher ownership before its pane mounts.
      const worktreeTabIds = (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map(
        (tab) => tab.id
      )
      revealActivationDeferredTabs({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId,
        allTabIds: worktreeTabIds,
        immediateTabIds: new Set(detail.tabIds ?? worktreeTabIds)
      })
      scheduleBackgroundTerminalWorktreeMeasure({
        mountedWorktreeIds: mountedWorktreeIdsRef.current,
        measurableBackgroundWorktreeIds: measurableBackgroundWorktreeIdsRef.current,
        timers,
        worktreeId,
        onRevision: () => setBackgroundMountRevision((revision) => revision + 1),
        setTimeoutFn: window.setTimeout,
        clearTimeoutFn: window.clearTimeout
      })
    }
    const onBackgroundMountTerminalWorktree = (event: Event): void => {
      const customEvent = event as CustomEvent<BackgroundMountTerminalWorktreeDetail>
      const worktreeId = customEvent.detail?.worktreeId
      const pending = takePendingBackgroundTerminalWorktreeMount(worktreeId)
      const detail = pending ?? customEvent.detail
      if (detail?.worktreeId) {
        applyBackgroundMount(detail)
      }
    }
    window.addEventListener(
      BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
      onBackgroundMountTerminalWorktree as EventListener
    )
    // Requests made while the lazy Terminal bundle/effect was absent stay in
    // the registry and are replayed only after the listener owns the surface.
    for (const pending of takeAllPendingBackgroundTerminalWorktreeMounts()) {
      applyBackgroundMount(pending)
    }
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

  useEffect(() => {
    const timers = terminalWorktreeParkingTimersRef.current
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }
      timers.clear()
    }
  }, [])

  // Why: worktree-level cold-park policy — hiddenSince bookkeeping, parked-set
  // selection, and one recheck timer per still-pending deadline so React
  // re-renders exactly when the hysteresis elapses instead of polling.
  useEffect(() => {
    const parkingTimers = terminalWorktreeParkingTimersRef.current
    for (const timer of parkingTimers.values()) {
      window.clearTimeout(timer)
    }
    parkingTimers.clear()

    const nowMs = Date.now()
    const overrides = getTerminalParkingPolicyOverrides()
    const portalWorktreeIds = new Set(activityTerminalPortals.map((portal) => portal.worktreeId))
    const currentWorktreeIds = new Set(workspaceSurfaces.map((workspace) => workspace.id))
    for (const worktreeId of Array.from(terminalWorktreeHiddenSinceRef.current.keys())) {
      if (!currentWorktreeIds.has(worktreeId) || !mountedWorktreeIdsRef.current.has(worktreeId)) {
        terminalWorktreeHiddenSinceRef.current.delete(worktreeId)
      }
    }

    const retentionCandidates: TerminalWorktreeColdParkCandidate[] = []
    for (const workspace of workspaceSurfaces) {
      const worktreeId = workspace.id
      if (!mountedWorktreeIdsRef.current.has(worktreeId)) {
        terminalWorktreeHiddenSinceRef.current.delete(worktreeId)
        continue
      }
      const isVisible = activeView === 'terminal' && renderedActiveWorktreeId === worktreeId
      const shouldMeasureHiddenWorktree =
        !isVisible && measurableBackgroundWorktreeIdsRef.current.has(worktreeId)
      const hasActivityTerminalPortal = portalWorktreeIds.has(worktreeId)
      if (isVisible || shouldMeasureHiddenWorktree || hasActivityTerminalPortal) {
        terminalWorktreeHiddenSinceRef.current.delete(worktreeId)
      } else if (!terminalWorktreeHiddenSinceRef.current.has(worktreeId)) {
        terminalWorktreeHiddenSinceRef.current.set(worktreeId, nowMs)
      }

      retentionCandidates.push({
        worktreeId,
        terminalTabs: tabsByWorktree[worktreeId] ?? [],
        isVisible,
        shouldMeasureHiddenWorktree,
        hasActivityTerminalPortal,
        hiddenSinceMs: terminalWorktreeHiddenSinceRef.current.get(worktreeId) ?? null
      })
    }

    const nextParkedTerminalWorktreeIds = selectColdParkedTerminalWorktrees({
      worktrees: retentionCandidates,
      pendingStartupByTabId,
      parkingEnabled: terminalParkingEnabled,
      nowMs,
      ...overrides
    })
    // Why: a worktree with any tab the byte watchers cannot cover (no
    // capture, no layout snapshot, legacy leaf ids) must never park — it
    // would go silent for bells/titles/completions, the failure that sank
    // the first parking attempt.
    for (const worktreeId of Array.from(nextParkedTerminalWorktreeIds)) {
      const tabs = tabsByWorktree[worktreeId] ?? []
      if (!tabs.every((tab) => canWatcherCoverParkedTerminalTab(worktreeId, tab))) {
        nextParkedTerminalWorktreeIds.delete(worktreeId)
      }
    }
    setParkedTerminalWorktreeIds((current) =>
      haveSameWorktreeIds(current, nextParkedTerminalWorktreeIds)
        ? current
        : nextParkedTerminalWorktreeIds
    )

    for (const candidate of retentionCandidates) {
      if (
        candidate.isVisible ||
        candidate.shouldMeasureHiddenWorktree ||
        candidate.hasActivityTerminalPortal ||
        nextParkedTerminalWorktreeIds.has(candidate.worktreeId)
      ) {
        continue
      }
      const delayMs = getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: terminalParkingEnabled,
        hiddenSinceMs: candidate.hiddenSinceMs,
        nowMs,
        ...overrides
      })
      if (delayMs !== null && delayMs > 0) {
        const worktreeId = candidate.worktreeId
        const timer = window.setTimeout(() => {
          parkingTimers.delete(worktreeId)
          setTerminalParkingRevision((revision) => revision + 1)
        }, delayMs)
        parkingTimers.set(worktreeId, timer)
      }
    }
  }, [
    activeView,
    activityTerminalPortals,
    backgroundMountRevision,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalParkingRevision,
    workspaceSurfaces
  ])
  // Why: gated on workspaceSessionReady to prevent TerminalPane from mounting
  // before reconnectPersistedTerminals() has finished eagerly spawning PTYs.
  // Without this gate, Phase 1 (hydrateWorkspaceSession) sets activeWorktreeId
  // with ptyId: null, and TerminalPane would call connectPanePty → pty:spawn,
  // creating a duplicate PTY for the same tab.
  if (renderedActiveWorktreeId && workspaceSessionReady) {
    // A real activation supersedes any targeted background mount, but a cold
    // activation must not mount every saved tab in one pass: each TerminalPane
    // mount replays scrollback through xterm, attaches a WebGL renderer, and
    // issues a sync-IPC snapshot read, so a whole-worktree stampede freezes
    // the renderer for the entire activation. Hidden tabs defer like
    // cold-parked tabs from birth and mount on first reveal.
    const worktreeTabs = tabsByWorktree[renderedActiveWorktreeId] ?? []
    const coldActivationDeferralEnabled =
      terminalParkingEnabled && terminalTitleSnapshotAuthorityEnabled
    const immediateTabIds = new Set<string>()
    if (activeTabId) {
      immediateTabIds.add(activeTabId)
    }
    // Why: on a fresh switch the global activeTabId can still point at the
    // previous worktree for one pass; the remembered per-worktree tab is the
    // one about to become visible.
    const rememberedActiveTabId = activeTabIdByWorktree[renderedActiveWorktreeId]
    if (rememberedActiveTabId) {
      immediateTabIds.add(rememberedActiveTabId)
    }
    // Why groups: split mode shows one tab per group at once, so every
    // group's active tab is user-visible and must not defer. group.activeTabId
    // is a unified-tab id — map it to the terminal tab's entity id, keeping
    // the raw id too in case older persisted groups stored entity ids.
    const unifiedTabById = new Map(
      (useAppStore.getState().unifiedTabsByWorktree[renderedActiveWorktreeId] ?? []).map(
        (unifiedTab) => [unifiedTab.id, unifiedTab]
      )
    )
    for (const group of groupsByWorktree[renderedActiveWorktreeId] ?? []) {
      if (!group.activeTabId) {
        continue
      }
      immediateTabIds.add(group.activeTabId)
      const activeUnifiedTab = unifiedTabById.get(group.activeTabId)
      if (activeUnifiedTab?.contentType === 'terminal') {
        immediateTabIds.add(activeUnifiedTab.entityId)
      }
    }
    for (const portal of activityTerminalPortals) {
      if (portal.worktreeId === renderedActiveWorktreeId) {
        immediateTabIds.add(portal.tabId)
      }
    }
    // Why: a queued startup needs a mounted pane to run its command.
    // pendingActivationSpawn is deliberately NOT immediate: session hydration
    // blanket-marks every persisted tab with it, and a deferred tab's reveal
    // consumes it exactly like an activation mount would — just later.
    for (const tab of worktreeTabs) {
      if (pendingStartupByTabId[tab.id] !== undefined) {
        immediateTabIds.add(tab.id)
      }
    }
    const activationHostSupportsDeferral = canDeferColdActivationTabsForHost({
      executionHostId: activeWorktreeDeferralHostId
    })
    if (lastActivationWorktreeIdRef.current !== renderedActiveWorktreeId) {
      lastActivationWorktreeIdRef.current = renderedActiveWorktreeId
      const tabById = new Map(worktreeTabs.map((tab) => [tab.id, tab]))
      planColdActivationTabDeferral({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId: renderedActiveWorktreeId,
        allTabIds: worktreeTabs.map((tab) => tab.id),
        isTabLive: hasRegisteredRuntimeTerminalTab,
        // Why the coverage gate: an unmounted tab's bells/titles/completions
        // are owned by parked byte watchers; a tab they cannot cover must
        // mount immediately, mirroring the cold-park eligibility rule.
        isTabDeferrable: (tabId) => {
          const tab = tabById.get(tabId)
          return (
            // Why: byte-mode watchers cannot reconstruct output emitted before
            // registration. Remote or unresolved ownership also mounts eagerly
            // because only a confirmed local daemon can provide snapshots.
            coldActivationDeferralEnabled &&
            activationHostSupportsDeferral &&
            tab !== undefined &&
            canWatcherCoverParkedTerminalTab(renderedActiveWorktreeId, tab)
          )
        },
        immediateTabIds
      })
    } else if (!coldActivationDeferralEnabled || !activationHostSupportsDeferral) {
      // Why: kill-switch or host-ownership changes while active must restore
      // eager mounting immediately, not strand an old local-only restriction.
      backgroundMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
      activationDeferredMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
    } else {
      // Why: tabs added after activation never passed the original coverage
      // gate. Uncoverable/no-PTY tabs must mount now so they can spawn or keep
      // their non-snapshot-backed live transport.
      for (const tab of worktreeTabs) {
        if (!canWatcherCoverParkedTerminalTab(renderedActiveWorktreeId, tab)) {
          immediateTabIds.add(tab.id)
        }
      }
      revealActivationDeferredTabs({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId: renderedActiveWorktreeId,
        allTabIds: worktreeTabs.map((tab) => tab.id),
        immediateTabIds
      })
    }
    mountedWorktreeIdsRef.current.add(renderedActiveWorktreeId)
  } else {
    // Why: the next ready activation must re-run the deferral decision even
    // if it re-activates the same worktree the session started on.
    lastActivationWorktreeIdRef.current = null
  }
  pruneClosedBackgroundMountTabs(
    backgroundMountTabIdsByWorktreeRef.current,
    mountedWorktreeIdsRef.current,
    tabsByWorktree,
    activationDeferredMountTabIdsByWorktreeRef.current
  )
  // Prune IDs of worktrees that no longer exist (deleted/removed)
  const allWorktreeIds = new Set(workspaceSurfaces.map((workspace) => workspace.id))
  for (const id of mountedWorktreeIdsRef.current) {
    if (!allWorktreeIds.has(id)) {
      mountedWorktreeIdsRef.current.delete(id)
      backgroundMountTabIdsByWorktreeRef.current.delete(id)
      activationDeferredMountTabIdsByWorktreeRef.current.delete(id)
    }
  }
  const anyMountedWorktreeHasLayout = computeAnyMountedWorktreeHasLayout(
    workspaceSurfaces.map((workspace) => workspace.id),
    mountedWorktreeIdsRef.current,
    layoutByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree
  )
  // Why: parked byte-watcher reconciliation for the legacy (non-split)
  // terminal host, which renders TerminalPanes directly. In split mode each
  // TerminalPaneOverlayLayer owns its worktree's watchers, so here we only
  // dispose worktrees that render no overlay layer (no layout / unmounted)
  // and prune watchers for deleted worktrees.
  useEffect(() => {
    pruneParkedTerminalWatchers(new Set(workspaceSurfaces.map((workspace) => workspace.id)))
    for (const workspace of workspaceSurfaces) {
      if (
        anyMountedWorktreeHasLayout &&
        mountedWorktreeIdsRef.current.has(workspace.id) &&
        getEffectiveLayoutForWorktree(workspace.id)
      ) {
        continue
      }
      const tabs = tabsByWorktree[workspace.id] ?? []
      const parkedTabIds = new Set<string>()
      let deferredTabIds: ReadonlySet<string> | null = null
      if (!anyMountedWorktreeHasLayout && mountedWorktreeIdsRef.current.has(workspace.id)) {
        const isVisible = activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
        const shouldMeasureHiddenWorktree =
          !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
        const parked =
          !isVisible && !shouldMeasureHiddenWorktree && parkedTerminalWorktreeIds.has(workspace.id)
        if (parked) {
          for (const tab of tabs) {
            const activityTerminalPortal = findActivityTerminalPortal(activityTerminalPortals, {
              worktreeId: workspace.id,
              tabId: tab.id
            })
            if (!activityTerminalPortal) {
              parkedTabIds.add(tab.id)
            }
          }
        }
        // Why: activation-deferred tabs are unmounted like parked ones; the
        // same byte watchers own their side effects until first reveal.
        // Targeted restrictions keep their existing delayed parking policy.
        deferredTabIds =
          activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
        for (const tab of tabs) {
          if (
            deferredTabIds?.has(tab.id) &&
            !parkedTabIds.has(tab.id) &&
            canWatcherCoverParkedTerminalTab(workspace.id, tab) &&
            !findActivityTerminalPortal(activityTerminalPortals, {
              worktreeId: workspace.id,
              tabId: tab.id
            })
          ) {
            parkedTabIds.add(tab.id)
          }
        }
      }
      syncParkedTerminalTabWatchers({
        worktreeId: workspace.id,
        tabs,
        parkedTabIds,
        // Why: activation-deferred tabs never mounted a pane to restore their
        // title, unlike ordinary parked tabs whose live pane populated it.
        ...(deferredTabIds ? { restoreTitleOnStartTabIds: deferredTabIds } : {})
      })
    }
  }, [
    // Why activeTabId: revealing a deferred tab mutates the mount restriction
    // during the same render; the watcher sync must re-run in that flush so
    // the revealed tab's watcher disposes before its pane attaches.
    activeTabId,
    activeView,
    activityTerminalPortals,
    activeTabIdByWorktree,
    anyMountedWorktreeHasLayout,
    backgroundMountRevision,
    getEffectiveLayoutForWorktree,
    groupsByWorktree,
    parkedTerminalWorktreeIds,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaces
  ])
  // Why: symmetric with useTerminalTabColdParking's unmount cleanup — when
  // the terminal host unmounts, no reconciliation effect will run again, so
  // dispose every remaining parked watcher here (overlay-layer children have
  // already disposed theirs by the time this parent cleanup runs).
  useEffect(() => () => disposeAllParkedTerminalWatchers(), [])
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
    if (isWebRuntimeSessionActive(getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId))) {
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
  }, [workspaceSessionReady, activeWorktreeId, createTab, reconcileWorktreeTabModel])

  const startupResumeWorktreeIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!workspaceSessionReady || !hydrationSucceeded || !activeWorktreeId) {
      return
    }
    if (startupResumeWorktreeIdsRef.current.has(activeWorktreeId)) {
      return
    }
    startupResumeWorktreeIdsRef.current.add(activeWorktreeId)
    // Why: startup hydration restores the active worktree without calling
    // activateAndRevealWorktree, so orphaned live/quit records need a terminal
    // surface pass after pane-level cold restore had first chance.
    resumeSleepingAgentSessionsForWorktree(activeWorktreeId)
  }, [activeWorktreeId, hydrationSucceeded, workspaceSessionReady])

  const handleNewTab = useCallback(
    (shellOverride?: string) => {
      if (!activeWorktreeId) {
        return
      }
      const targetGroupId =
        useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
        useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
      const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
      if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
        void createWebRuntimeSessionTerminal({
          worktreeId: activeWorktreeId,
          environmentId: runtimeEnvironmentId,
          targetGroupId,
          command: shellOverride,
          activate: true
        })
        return
      }
      if (!shellOverride && targetGroupId) {
        void openNewTerminalTabInActiveWorkspace(targetGroupId)
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
      activeWorktreeId,
      createTab,
      openNewTerminalTabInActiveWorkspace,
      setActiveTabType,
      setTabBarOrder
    ]
  )

  const handleNewAgentTab = useCallback(
    (agent: TuiAgent) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const targetGroupId =
        state.activeGroupIdByWorktree[activeWorktreeId] ??
        state.groupsByWorktree[activeWorktreeId]?.[0]?.id
      const result = launchAgentInNewTab({
        agent,
        worktreeId: activeWorktreeId,
        groupId: targetGroupId,
        launchSource: 'shortcut'
      })
      if (!result) {
        toast.error(
          translate(
            'auto.components.Terminal.e57db40c11',
            'Could not build launch command for {{value0}}.',
            { value0: agent }
          )
        )
      }
    },
    [activeWorktreeId]
  )

  const handleNewSimulatorTab = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const targetGroupId =
      useAppStore.getState().activeGroupIdByWorktree[activeWorktreeId] ??
      useAppStore.getState().groupsByWorktree[activeWorktreeId]?.[0]?.id
    void openMobileEmulatorTab(activeWorktreeId, {
      placement: 'rightSplit',
      targetGroupId: targetGroupId ?? undefined
    })
  }, [activeWorktreeId])

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
    const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void createWebRuntimeSessionBrowserTab({
        worktreeId: activeWorktreeId,
        environmentId: runtimeEnvironmentId,
        url: defaultUrl
      })
      return
    }
    createBrowserTab(activeWorktreeId, defaultUrl, {
      title: translate('auto.components.Terminal.37da0d736f', 'New Browser Tab'),
      focusAddressBar: true
    })
  }, [activeWorktreeId, createBrowserTab, openNewBrowserTabInActiveWorkspace])

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
      const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
      if (
        isWebRuntimeSessionActive(runtimeEnvironmentId) &&
        browserWorkspaceHasRemoteOwner(state, source.id, runtimeEnvironmentId)
      ) {
        void createWebRuntimeSessionBrowserTab({
          worktreeId: activeWorktreeId,
          environmentId: runtimeEnvironmentId,
          url: source.url,
          profileId: source.sessionProfileId
        })
        return
      }
      createBrowserTab(activeWorktreeId, source.url, {
        ...buildDuplicatedBrowserTabOptions(source)
      })
    },
    [activeWorktreeId, createBrowserTab]
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
      const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(owningWorktreeId)
      if (
        isWebRuntimeSessionActive(runtimeEnvironmentId) &&
        browserWorkspaceHasRemoteOwner(state, tabId, runtimeEnvironmentId)
      ) {
        void closeWebRuntimeSessionTab({
          worktreeId: owningWorktreeId,
          tabId,
          environmentId: runtimeEnvironmentId
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
      // Why: a parked multi-leaf tab has no PaneManager to promote split
      // siblings, so closing the tab here would kill them; the reveal
      // remount handles dead PTYs per leaf instead.
      if (shouldDeferParkedPtyExitTabClose(tabId, ptyId)) {
        return
      }
      closeTerminalTab(tabId, { reason: 'pty-exit' })
    },
    [consumeSuppressedPtyExit]
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
        const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
        if (
          isWebRuntimeSessionActive(runtimeEnvironmentId) &&
          (unifiedTab?.contentType === 'terminal' ||
            (unifiedTab?.contentType === 'browser' &&
              browserWorkspaceHasRemoteOwner(state, unifiedTab.entityId, runtimeEnvironmentId)))
        ) {
          if (unifiedTab.contentType === 'terminal') {
            // Why: paired-host bulk close must revoke renderer resume and hook
            // authority as well as removing the host-owned session tab.
            closeTerminalTab(unifiedTab.entityId)
          } else {
            void closeWebRuntimeSessionTab({
              worktreeId: activeWorktreeId,
              tabId: unifiedTab.id,
              environmentId: runtimeEnvironmentId
            })
          }
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
    [activeWorktreeId, closeBrowserTab, closeFile, closeTab, queueEditorCloseRequests]
  )

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const currentOrder = state.tabBarOrderByWorktree[activeWorktreeId] ?? []
      const index = currentOrder.indexOf(tabId)
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
        const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
        if (
          isWebRuntimeSessionActive(runtimeEnvironmentId) &&
          (unifiedTab?.contentType === 'terminal' ||
            (unifiedTab?.contentType === 'browser' &&
              browserWorkspaceHasRemoteOwner(state, unifiedTab.entityId, runtimeEnvironmentId)))
        ) {
          if (unifiedTab.contentType === 'terminal') {
            // Why: route every terminal close through the destructive local
            // lifecycle boundary before the paired host RPC.
            closeTerminalTab(unifiedTab.entityId)
          } else {
            void closeWebRuntimeSessionTab({
              worktreeId: activeWorktreeId,
              tabId: unifiedTab.id,
              environmentId: runtimeEnvironmentId
            })
          }
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
    [activeWorktreeId, closeBrowserTab, closeFile, closeTab, queueEditorCloseRequests]
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
      const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
      if (activeWorktreeId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
        void activateWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId,
          environmentId: runtimeEnvironmentId
        })
      }
      setActiveTab(tabId)
      setActiveTabType('terminal')
    },
    [activeWorktreeId, setActiveTab, setActiveTabType]
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
      const state = useAppStore.getState()
      const runtimeEnvironmentId = getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId)
      if (
        activeWorktreeId &&
        isWebRuntimeSessionActive(runtimeEnvironmentId) &&
        browserWorkspaceHasRemoteOwner(state, tabId, runtimeEnvironmentId)
      ) {
        void activateWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId,
          environmentId: runtimeEnvironmentId
        })
      }
      setActiveBrowserTab(tabId)
      setActiveTabType('browser')
    },
    [activeWorktreeId, setActiveBrowserTab, setActiveTabType]
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

      // Cmd/Ctrl+Alt+T (macOS default) — launch the default agent in a new
      // tab; per-agent chords (Settings → Shortcuts → Agents) launch their
      // specific agent. Unlike Cmd+T this never targets the floating panel:
      // agent sessions belong to a worktree, so the launch always lands in
      // the active workspace's tab bar.
      if (!e.repeat) {
        const state = useAppStore.getState()
        let agentActionId: KeybindingActionId | null = null
        let agentToLaunch: TuiAgent | null = null
        if (matchShortcut('tab.newAgent')) {
          const connectionId = getConnectionId(activeWorktreeId)
          agentActionId = 'tab.newAgent'
          agentToLaunch = resolveDefaultAgentForNewTab({
            defaultTuiAgent: state.settings?.defaultTuiAgent,
            detectedAgentIds:
              typeof connectionId === 'string'
                ? state.remoteDetectedAgentIds[connectionId]
                : state.detectedAgentIds,
            disabledTuiAgents: state.settings?.disabledTuiAgents
          })
        } else {
          for (const bound of listBoundAgentTabActions(
            keybindings,
            state.settings?.disabledTuiAgents
          )) {
            if (matchShortcut(bound.actionId)) {
              agentActionId = bound.actionId
              // Why: a per-agent chord is an explicit request for that agent,
              // so launch it even when detection hasn't (or can't have)
              // confirmed the binary; a missing CLI fails visibly in the tab.
              agentToLaunch = bound.agent
              break
            }
          }
        }
        if (agentActionId) {
          e.preventDefault()
          notifyTerminalCapture(agentActionId)
          if (agentToLaunch) {
            handleNewAgentTab(agentToLaunch)
          } else {
            toast.message(
              translate(
                'auto.components.Terminal.5b2c1a9e44',
                'No agent CLI detected — install one or pick a default agent in Settings.'
              )
            )
          }
          return
        }
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

      // Cmd/Ctrl+Shift+E — new mobile emulator tab (macOS only)
      if (!e.repeat && mobileEmulatorEnabled && matchShortcut('tab.newSimulator')) {
        e.preventDefault()
        notifyTerminalCapture('tab.newSimulator')
        if (!floatingWorkspaceFocused) {
          handleNewSimulatorTab()
        }
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
              err instanceof Error
                ? err.message
                : translate(
                    'auto.components.Terminal.f0600556b3',
                    'Failed to create untitled markdown file.'
                  )
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

      // Cmd/Ctrl+Alt+W - close every editor file tab in the active worktree.
      // Why: reuse the context-menu close-all path so pinned and dirty-file
      // rules stay identical; terminal focus still honors shortcut policy.
      if (!e.repeat && matchShortcut('tab.closeAll')) {
        e.preventDefault()
        notifyTerminalCapture('tab.closeAll')
        handleCloseAllFiles()
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
    handleNewSimulatorTab,
    handleNewFile,
    handleNewTab,
    handleNewAgentTab,
    handleCloseTab,
    handleCloseBrowserTab,
    closeBrowserTab,
    handleCloseFile,
    handleCloseAllFiles,
    keybindings,
    mobileEmulatorEnabled,
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

  // Handle main-process window close requests. Terminal sessions are detached
  // by the daemon/SSH lifecycle; only dirty editor files should block close
  // here. Explicit destructive terminal actions keep their own confirms.
  // Why: register into the coordinator rather than subscribing to IPC directly.
  // The single IPC subscription lives at the always-mounted App root, so quits
  // on the no-workspace landing page (where Terminal is not mounted) are still
  // handled instead of deadlocking the window (#5144).
  useEffect(() => {
    setWindowCloseRequestHandler(({ isQuitting }) => {
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
    return () => setWindowCloseRequestHandler(null)
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
            onNewSimulatorTab={mobileEmulatorEnabled ? handleNewSimulatorTab : undefined}
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
            activeSimulatorTabId={
              activeTabType === 'simulator' && renderedActiveWorktreeId
                ? (useAppStore.getState().getActiveTab(renderedActiveWorktreeId)?.id ?? null)
                : null
            }
            activeTabType={activeTabType}
            onActivateFile={(fileId) => {
              const unifiedTabs =
                useAppStore.getState().unifiedTabsByWorktree[renderedActiveWorktreeId ?? ''] ?? []
              const unifiedTab = unifiedTabs.find((tab) => tab.id === fileId)
              if (unifiedTab?.contentType === 'simulator') {
                setActiveTab(fileId)
                setActiveTabType('simulator')
                return
              }
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
          {workspaceSurfaces
            .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
            .map((workspace) => {
              const layout = getEffectiveLayoutForWorktree(workspace.id)
              if (!layout) {
                return null
              }
              // Why: use strict equality with 'terminal' instead of !== 'settings'
              // so the terminal/browser surface hides on the tasks page too.
              const isVisible =
                activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
              const shouldMeasureHiddenWorktree =
                !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
              const shouldColdParkTerminalPanes =
                !isVisible &&
                !shouldMeasureHiddenWorktree &&
                parkedTerminalWorktreeIds.has(workspace.id)
              return (
                <WorktreeSplitSurface
                  key={`tab-groups-${workspace.id}`}
                  worktreeId={workspace.id}
                  worktreePath={workspace.path}
                  layout={layout}
                  focusedGroupId={activeGroupIdByWorktree[workspace.id]}
                  isVisible={isVisible}
                  shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
                  shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
                  activityTerminalPortals={activityTerminalPortals}
                  backgroundMountTabIds={
                    backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
                  }
                  activationDeferredMountTabIds={
                    activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
                  }
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
              (activeTabType === 'browser' && worktreeBrowserTabs.length > 0) ||
              activeTabType === 'simulator'
                ? 'hidden'
                : ''
            }`}
          >
            {workspaceSurfaces
              .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
              .map((workspace) => {
                // Why: use strict equality with 'terminal' instead of !== 'settings'
                // so the terminal/browser surface hides on the tasks page too.
                const isVisible =
                  activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
                const shouldMeasureHiddenWorktree =
                  !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
                const shouldColdParkTerminalPanes =
                  !isVisible &&
                  !shouldMeasureHiddenWorktree &&
                  parkedTerminalWorktreeIds.has(workspace.id)
                return (
                  <div
                    key={workspace.id}
                    className={
                      isVisible
                        ? 'absolute inset-0'
                        : shouldMeasureHiddenWorktree
                          ? 'absolute inset-0 opacity-0 pointer-events-none'
                          : 'absolute inset-0 hidden'
                    }
                    aria-hidden={!isVisible}
                  >
                    <CodexRestartChip isVisible={isVisible} worktreeId={workspace.id} />
                    {(tabsByWorktree[workspace.id] ?? [])
                      .filter((tab) =>
                        shouldMountBackgroundWorktreeTab(
                          backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null,
                          tab.id
                        )
                      )
                      .map((tab) => {
                        const activityTerminalPortal = findActivityTerminalPortal(
                          activityTerminalPortals,
                          { worktreeId: workspace.id, tabId: tab.id }
                        )
                        const isActivityPortalTab = activityTerminalPortal !== null
                        const isActiveTerminalTab =
                          isVisible && tab.id === activeTabId && activeTabType === 'terminal'
                        // Why: parking unmounts the view while preserving the PTY;
                        // an Activity portal remains mounted as a visible consumer.
                        if (shouldColdParkTerminalPanes && !isActivityPortalTab) {
                          return null
                        }
                        const terminalPane = (
                          <TerminalPane
                            key={`${tab.id}-${tab.generation ?? 0}`}
                            tabId={tab.id}
                            worktreeId={workspace.id}
                            cwd={tab.startupCwd ?? workspace.path}
                            isActive={
                              isActiveTerminalTab || activityTerminalPortal?.active === true
                            }
                            // Why: the activity page hosts this existing pane via
                            // portal while the workspace surface remains hidden.
                            // Keeping `isVisible` true for the portaled tab lets
                            // xterm fit and stream foreground output in-place.
                            isVisible={isActiveTerminalTab || isActivityPortalTab}
                            // Why: inactive tabs in the visible legacy surface
                            // are tab-hidden, not worktree-hidden, so they need
                            // the same light resume path as split-group overlays.
                            isWorktreeActive={isVisible || isActivityPortalTab}
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
            {workspaceSurfaces.map((workspace) => {
              const browserTabs = browserTabsByWorktree[workspace.id] ?? []
              // Why: use strict equality with 'terminal' instead of !== 'settings'
              // so browser panes also hide on the tasks page.
              const isVisibleWorktree =
                activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
              if (browserTabs.length === 0) {
                return null
              }
              return (
                <div
                  key={`browser-${workspace.id}`}
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
                  {translate('auto.components.Terminal.5c1d2a32bb', 'Loading editor...')}
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
            <DialogTitle className="text-sm">
              {translate('auto.components.Terminal.21295c6b8c', 'Unsaved Changes')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {saveDialogFile
                ? translate(
                    'auto.components.Terminal.61ed600d29',
                    '"{{value0}}" has unsaved changes. Do you want to save before closing?',
                    { value0: basename(saveDialogFile.relativePath) }
                  )
                : translate(
                    'auto.components.Terminal.46e08bc5c8',
                    'This file has unsaved changes.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogCancel}>
              {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogDiscard}>
              {translate('auto.components.Terminal.0037b21794', "Don't Save")}
            </Button>
            <Button type="button" size="sm" onClick={handleSaveDialogSave}>
              {translate('auto.components.Terminal.cd51e28d8b', 'Save')}
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
            <DialogTitle className="text-sm">
              {translate('auto.components.Terminal.2fa9c69ff3', 'Close Window?')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.Terminal.7958465754',
                'There are local terminals with running processes. Close the window anyway?'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setWindowCloseDialogOpen(false)}
            >
              {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
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
              {translate('auto.components.Terminal.73768427cf', 'Close')}
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
  shouldColdParkTerminalPanes,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds
}: {
  worktreeId: string
  worktreePath: string
  layout: TabGroupLayoutNode
  focusedGroupId?: string
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  shouldColdParkTerminalPanes: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
}): React.JSX.Element {
  const browserPageIds = useAppStore(
    useShallow((state) =>
      (state.browserTabsByWorktree[worktreeId] ?? []).flatMap((tab) =>
        tab.pageIds && tab.pageIds.length > 0 ? tab.pageIds : [tab.activePageId ?? tab.id]
      )
    )
  )
  const hasAutomationVisibleBrowser = useBrowserAutomationVisibilityForAny(browserPageIds)
  const hasMobileDrivenBrowser = useBrowserMobileDriverForAny(browserPageIds)
  const shouldKeepPaintable =
    shouldMeasureHiddenWorktree || hasAutomationVisibleBrowser || hasMobileDrivenBrowser

  return (
    <div
      className={
        isVisible
          ? 'absolute inset-0 flex'
          : shouldKeepPaintable
            ? 'absolute inset-0 flex opacity-0 pointer-events-none'
            : 'absolute inset-0 hidden'
      }
      // Why: automation and mobile control need paintable webviews, but hidden
      // worktree controls cannot remain reachable by Tab or assistive tech.
      inert={!isVisible}
      aria-hidden={!isVisible}
    >
      <CodexRestartChip isVisible={isVisible} worktreeId={worktreeId} />
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
        coldParkTerminalPanes={shouldColdParkTerminalPanes}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIds}
        activationDeferredMountTabIds={activationDeferredMountTabIds}
      />
      {isVisible || backgroundMountTabIds === null ? (
        <>
          <BrowserPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isVisible} />
          <EmulatorPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isVisible} />
        </>
      ) : null}
      <AiVaultSessionDropLayer worktreeId={worktreeId} enabled={isVisible} />
    </div>
  )
})

export default React.memo(Terminal)
