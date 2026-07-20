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
import { preventUnloadAndScheduleShutdownCheckpointReset } from '@/lib/shutdown-checkpoint-guard'
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
import { terminalProviderHasAuthoritativeSnapshot } from './terminal/terminal-provider-snapshot-capability'
import { useTerminalProviderSnapshotCapability } from './terminal/use-terminal-provider-snapshot-capability'
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

// Why: gate handler runs after a dialog advances so a stray carry-over click can't act on the next dialog; ~200ms absorbs a physical double-click while staying responsive.
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
  // Why: use the activity page's selectedThread descriptor, not activeWorktreeId/activeTabId — selectThread updates the store in steps, so deriving here flashed the wrong terminal.
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
    // Why: hibernation must treat terminals portaled into foreground surfaces as visible even when not the active tab.
    setForegroundTerminalTabIds(foregroundTerminalTabIds)
    return () => setForegroundTerminalTabIds([])
  }, [foregroundTerminalTabIds])

  const tabs = useMemo(
    () => (renderedActiveWorktreeId ? (tabsByWorktree[renderedActiveWorktreeId] ?? []) : []),
    [renderedActiveWorktreeId, tabsByWorktree]
  )
  useTerminalProviderSnapshotCapability(workspaceSessionReady && hydrationSucceeded)

  // Why: TabBar portals into the titlebar (target created by App.tsx) so tabs share the "Orca" title row.
  const titlebarTabsTarget = document.getElementById('titlebar-tabs')

  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }
    // Why: ensure a root group exists so terminal-first fallback can attach fresh tabs to a concrete owner before any explicit split.
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

  // Why: track the file whose save-and-close is in flight so getNextQueuedEditorClose skips it and concurrent close requests can't re-open the dialog over it.
  const inFlightSaveFileIdRef = useRef<string | null>(null)

  // Why: gate the Save/Discard/Cancel handlers so a stray carry-over click doesn't act on the next dialog before the user reads it; released after CLOSE_DIALOG_DEBOUNCE_MS.
  const isClosingRef = useRef(false)
  const closeDialogDebounceTimersRef = useRef<Set<number>>(new Set())
  const releaseCloseDialogGuardAfterDebounce = useCallback(() => {
    const timer = window.setTimeout(() => {
      closeDialogDebounceTimersRef.current.delete(timer)
      isClosingRef.current = false
    }, CLOSE_DIALOG_DEBOUNCE_MS)
    closeDialogDebounceTimersRef.current.add(timer)
  }, [])

  // Window close confirmation, shown for local terminals with running children (SSH terminals detach/persist via the relay).
  const [windowCloseDialogOpen, setWindowCloseDialogOpen] = useState(false)

  // Why: defer confirmWindowClose() while tabs are dirty — the beforeunload guard preventDefault()s, so an immediate confirm leaves the window open with no UI.
  const windowCloseAfterDirtyRef = useRef<{ isQuitting: boolean } | null>(null)

  const confirmNativeWindowClose = useCallback(() => {
    // Why: capture only after every close guard has committed. A canceled child-
    // process prompt must not consume App's synthetic/native unload guard.
    const accepted = window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    if (!accepted) {
      return
    }
    window.api.ui.confirmWindowClose()
  }, [])

  const proceedToNativeWindowClose = useCallback(
    (isQuitting: boolean) => {
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
                confirmNativeWindowClose()
              }
            }
          )
          return
        }
      }
      confirmNativeWindowClose()
    },
    [confirmNativeWindowClose]
  )

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
      // Why: zustand only fires subscribers on later changes, so re-check in case the file closed between the guard and subscribe.
      if (!useAppStore.getState().openFiles.some((f) => f.id === fileId)) {
        window.clearTimeout(timeoutId)
        unsub?.()
        resolve(true)
      }
    })
  }, [])

  const getNextQueuedEditorClose = useCallback((): string | null => {
    // Why: bulk closes enqueue files that may go clean or vanish before reaching the front; drain them so the dialog only blocks on tabs still needing a decision.
    while (pendingEditorCloseQueueRef.current.length > 0) {
      const fileId = pendingEditorCloseQueueRef.current[0]
      // Why: skip a fileId with an in-flight save; waitForFileClosed re-advances the queue once it closes or times out.
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
      // Why: the queue can cross worktrees during window-close; switch to the file's worktree so the UI behind the dialog matches its filename.
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

    // Why: signal the headless autosave controller via event (not editor refs) so save-and-close flushes even when the editor panel has unmounted.
    setSaveDialogFileId(null)
    window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId } }))
    inFlightSaveFileIdRef.current = fileId
    let closed = false
    try {
      closed = await waitForFileClosed(fileId, 10_000)
    } finally {
      // Why: clear the in-flight ref on success or timeout so getNextQueuedEditorClose no longer treats the queue head as un-advanceable.
      if (inFlightSaveFileIdRef.current === fileId) {
        inFlightSaveFileIdRef.current = null
      }
    }
    if (!closed) {
      // Why: the save may have resolved just after the timeout fired; re-check so we drain/advance instead of re-opening a stale dialog, toasting only real timeouts.
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
      // Why: on a genuine timeout the user stays on the same dialog, so release the guard now — a new click is a deliberate retry.
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

    // Why: dismiss synchronously before awaiting quiesce so a double-click can't fire twice with the same fileId and double-advance the queue.
    setSaveDialogFileId(null)

    // Why: wait for background autosave to settle before "Don't Save", else a write can land after the user chose to discard.
    try {
      await requestEditorSaveQuiesce({ fileId })
    } catch (error) {
      // Why: don't trap the user in the close-dialog loop on quiesce failure, but still warn so a stuck controller stays visible.
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
    // Why: prefer the remembered active tab so a repair on a transient switch render doesn't reset selection to Terminal 1.
    const repairedTabId = resolveRepairedActiveTerminalTabId({
      activeTabType,
      activeTabId,
      rememberedTabId,
      tabs
    })
    if (!repairedTabId) {
      return
    }
    // Why: run in an effect (Zustand mutation during render trips React's cross-component update warning); keep terminal-only so inactive CLI-created tabs can't steal editor/browser focus.
    setActiveTab(repairedTabId)
    // Why: `tabs` is the dependency so the repair reacts to tab-order/content changes, not just scalar IDs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTabId,
    activeTabType,
    setActiveTab,
    tabs,
    activeTabIdByWorktree,
    renderedActiveWorktreeId
  ])

  // Why: only mount TerminalPanes for visited worktrees, else restoring many saved tabs mass-spawns PTYs.
  const measurableBackgroundWorktreeTimersRef = useRef(new Map<string, number>())
  const [backgroundMountRevision, setBackgroundMountRevision] = useState(0)
  const [terminalParkingRevision, setTerminalParkingRevision] = useState(0)
  const [parkedTerminalWorktreeIds, setParkedTerminalWorktreeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Tab restriction for targeted background mounts (wake/resume); a worktree absent from this map mounts all its tabs.
  const backgroundMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  // Why: only cold-activation deferral (not targeted mounts, which share the map above) creates watcher coverage for every unmounted tab.
  const activationDeferredMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  // Why: run the cold-activation deferral decision once per activation transition, not on every re-render.
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
      // Why: a targeted wake can reveal an earlier activation-deferred tab; drop it from watcher ownership before its pane mounts.
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
    // Replay mounts requested while the lazy Terminal bundle/effect was absent, now that the listener owns the surface.
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
      // Close-dialog debounce timers are Terminal-owned, so clear them with the Terminal lifetime cleanup.
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

  // Worktree cold-park policy: hiddenSince bookkeeping, parked-set selection, and one recheck timer per deadline so React re-renders when hysteresis elapses instead of polling.
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
    // Why: a worktree with any watcher-uncoverable tab must never park, or it goes silent for bells/titles/completions (sank the first parking attempt).
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
  // Why: gate on workspaceSessionReady so TerminalPane doesn't mount and spawn a duplicate PTY before reconnectPersistedTerminals() finishes.
  if (renderedActiveWorktreeId && workspaceSessionReady) {
    // Why: mounting every saved tab at once (scrollback replay + WebGL + sync-IPC snapshot per pane) freezes the renderer, so hidden tabs defer and mount on first reveal.
    const worktreeTabs = tabsByWorktree[renderedActiveWorktreeId] ?? []
    const coldActivationDeferralEnabled =
      terminalParkingEnabled && terminalTitleSnapshotAuthorityEnabled
    const immediateTabIds = new Set<string>()
    if (activeTabId) {
      immediateTabIds.add(activeTabId)
    }
    // Why: on a fresh switch the global activeTabId lags to the previous worktree for one pass; the remembered per-worktree tab is the one about to show.
    const rememberedActiveTabId = activeTabIdByWorktree[renderedActiveWorktreeId]
    if (rememberedActiveTabId) {
      immediateTabIds.add(rememberedActiveTabId)
    }
    // Why groups: split mode shows each group's active tab at once, so none may defer; map the unified-tab id to its entity id (keep the raw id for legacy groups that stored entity ids).
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
    // Why: a queued startup needs a mounted pane to run; pendingActivationSpawn is excluded because hydration marks every persisted tab and a deferred reveal consumes it later.
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
        // Why the coverage gate: parked byte watchers own an unmounted tab's bells/titles/completions, so a tab they can't cover must mount immediately.
        isTabDeferrable: (tabId) => {
          const tab = tabById.get(tabId)
          return (
            // Why: byte-mode watchers can't reconstruct pre-registration output; remote/unresolved ownership mounts eagerly since only a local daemon has snapshots.
            coldActivationDeferralEnabled &&
            activationHostSupportsDeferral &&
            tab !== undefined &&
            canWatcherCoverParkedTerminalTab(
              renderedActiveWorktreeId,
              tab,
              terminalProviderHasAuthoritativeSnapshot
            )
          )
        },
        immediateTabIds
      })
    } else if (!coldActivationDeferralEnabled || !activationHostSupportsDeferral) {
      // Why: kill-switch or host-ownership change while active must restore eager mounting, not strand an old restriction.
      backgroundMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
      activationDeferredMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
    } else {
      // Why: tabs added after activation never passed the coverage gate — uncoverable/no-PTY ones must mount now to spawn or keep their live transport.
      for (const tab of worktreeTabs) {
        if (
          !canWatcherCoverParkedTerminalTab(
            renderedActiveWorktreeId,
            tab,
            terminalProviderHasAuthoritativeSnapshot
          )
        ) {
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
    // Why: reset so the next ready activation re-runs the deferral decision even for the same worktree.
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
  // Why: legacy (non-split) host owns watcher reconciliation; split mode's overlay layers own theirs, so only dispose worktrees with no overlay layer.
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
        // Why: activation-deferred tabs are unmounted like parked ones — the same byte watchers own their side effects until first reveal.
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
        // Why: activation-deferred tabs never mounted a pane to restore their title, unlike ordinary parked tabs.
        ...(deferredTabIds ? { restoreTitleOnStartTabIds: deferredTabIds } : {})
      })
    }
  }, [
    // Why activeTabId: revealing a deferred tab mutates the mount restriction in the same render; sync must re-run so its watcher disposes before the pane attaches.
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
  // Why: on host unmount no reconciliation effect runs again, so dispose every remaining parked watcher here.
  useEffect(() => () => disposeAllParkedTerminalWatchers(), [])
  // Auto-create first tab when worktree activates
  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }
    if (!activeWorktreeId) {
      return
    }
    // Why: host session-tabs are authoritative in the paired web client; a local fallback races the host's initial terminal and duplicates tabs.
    if (isWebRuntimeSessionActive(getActiveWorktreeRuntimeEnvironmentId(activeWorktreeId))) {
      return
    }

    // Why: give a newly activated worktree a focusable surface when nothing renders, without recreating one after the user closes the last visible tab.
    const { renderableTabCount } = reconcileWorktreeTabModel(activeWorktreeId)
    if (!shouldAutoCreateInitialTerminal(renderableTabCount)) {
      return
    }
    // Why: tag this never-visited-worktree tab so its PTY spawn doesn't count as activity and reshuffle the sidebar (explicit New Tab still bumps).
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
    // Why: startup hydration restores the worktree without activateAndRevealWorktree, so orphaned live/quit records need a terminal-surface pass after cold restore.
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
      // Why: persist tab-bar order with the new terminal appended; else reconcileOrder falls back to terminals-first and jumps it to index 0 before editor tabs.
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
      // Why: shell-specific creation still uses the legacy path; keep focus here until the lifted action accepts shell overrides.
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
      // Why: a parked multi-leaf tab has no PaneManager to promote split siblings, so closing here would kill them; reveal-remount handles dead PTYs per leaf.
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
            // Why: paired-host bulk close must revoke renderer resume and hook authority, not just remove the host session tab.
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
            // Why: route terminal close through the destructive local lifecycle boundary before the paired-host RPC.
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
      // Why: Cmd/Ctrl+T always opens a terminal regardless of active surface; browser tabs have their own chord (Cmd/Ctrl+Shift+B).
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

      // Cmd/Ctrl+Alt+T — launch the default agent in a new tab (per-agent chords launch specific agents).
      // Why: unlike Cmd+T this never targets the floating panel — agent sessions belong to a worktree.
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
              // Why: a per-agent chord is explicit, so launch even if detection didn't confirm the binary — a missing CLI fails visibly in the tab.
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

      // Cmd/Ctrl+Shift+T — reopen the most recently closed tab (terminal/browser/editor), Chrome-style; repeats walk back through history.
      if (!e.repeat && matchShortcut('tab.reopenClosed')) {
        e.preventDefault()
        notifyTerminalCapture('tab.reopenClosed')
        useAppStore.getState().reopenClosedTab(activeWorktreeId)
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

      // Save active editor file — fallback for when focus is outside the editor (tab bar/sidebar); editor-local handlers own save when the editor is focused.
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

      // Cmd/Ctrl+W — close active editor/browser tab or terminal pane. Terminal close lives in keyboard-handlers.ts (split panes + confirm dialog).
      // Why: still preventDefault here so Electron doesn't run its default Cmd+W window-close.
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

      // Cmd/Ctrl+Alt+W — close every editor file tab in the active worktree.
      // Why: reuse the context-menu close-all path so pinned/dirty-file rules stay identical.
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

      // Why: match on e.code, not e.key — macOS Shift+[ reports '{' and Option+[ composes dead-keys, so e.key misses the chord on many layouts.
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
        // Why: share the IPC-path handler and always consume the chord (even single-tab no-op) so it never reaches xterm or the browser guest.
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

      // Ctrl+PageDown/PageUp — switch terminal tabs only. Ctrl on every platform since macOS Cmd+PageUp/Down is an OS desktop-switch shortcut.
      // Why: reject Shift too so Ctrl+Shift+PageUp/Down stays free for focused terminal/editor consumers.
      const terminalTabDirection = matchShortcut('tab.nextTerminal')
        ? 1
        : matchShortcut('tab.previousTerminal')
          ? -1
          : null
      if (!e.repeat && terminalTabDirection !== null) {
        // Why: fully consume the chord (preventDefault alone won't stop xterm's listener); else xterm writes \e[5~/\e[6~ escapes to the shell even in the single-terminal no-op case.
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
      // Why: intentional restarts pre-save dirty tabs, so don't let stale dirty flags veto the relaunch.
      if (isIntentionalAppRestartInProgress()) {
        return
      }
      const dirtyFiles = useAppStore.getState().openFiles.filter((f) => f.isDirty)
      if (dirtyFiles.length > 0) {
        preventUnloadAndScheduleShutdownCheckpointReset(e, window)
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Handle main-process window close requests: only dirty editor files block close (terminal sessions detach via daemon/SSH).
  // Why: register into the coordinator, not IPC directly, so quits on the Terminal-less landing page are still handled (#5144).
  useEffect(() => {
    setWindowCloseRequestHandler(({ isQuitting }) => {
      if (isIntentionalAppRestartInProgress()) {
        window.api.ui.confirmWindowClose()
        return
      }

      // Why: ignore duplicate quit signals while a close is in flight, else the in-flight ref is overwritten and the close sequence is lost.
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

  // Why: browser pages can vanish via store-only paths; the store can't destroy webviews (owns DOM nodes), so this subscriber tears down orphaned ones.
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

  // Why: fall back to terminal when activeTabType 'browser' has no renderable tab; run as effect, not render (Zustand mutations mid-render blank the screen).
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

      {/* Why: with split groups each group owns its inline tab strip; this titlebar portal is only a fallback before the root-group layout exists. */}
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

      {/* Why: no full-width titlebar in workspace view — tab groups + terminal extend to the window top. */}

      {anyMountedWorktreeHasLayout ? (
        <div
          className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${effectiveActiveLayout ? '' : ' hidden'}`}
        >
          {/* Why: absolutely position each mounted surface so hidden trees don't reflow the active one; the relative anchor sizes panes to the workspace body. */}
          {workspaceSurfaces
            .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
            .map((workspace) => {
              const layout = getEffectiveLayoutForWorktree(workspace.id)
              if (!layout) {
                return null
              }
              // Why: strict '=== terminal' (not !== settings) so the terminal/browser surface hides on the tasks page too.
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
          {/* Why: render only one surface model — legacy panes mounted alongside split-group panes race two React trees over one PTY/webview; gate on !anyMountedWorktreeHasLayout too so shutdown-from-focused doesn't respawn PTYs and re-light the sidebar dot. */}
          {/* Terminal panes container - hidden when editor tab active */}
          <div
            className={`relative flex-1 min-h-0 overflow-hidden ${
              // Why: only hide the terminal when another tab type has content; else a stale activeTabType (e.g. 'editor' with no files after restore) blanks the screen.
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
                // Why: strict '=== terminal' (not !== settings) so the terminal/browser surface hides on the tasks page too.
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
                        // Why: parking unmounts the view but keeps the PTY; an Activity portal stays mounted as a visible consumer.
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
                            // Why: keep isVisible true for the portaled tab so xterm fits/streams while the workspace surface stays hidden.
                            isVisible={isActiveTerminalTab || isActivityPortalTab}
                            // Why: inactive tabs here are tab-hidden (not worktree-hidden), so they need the same light resume path as split-group overlays.
                            isWorktreeActive={isVisible || isActivityPortalTab}
                            // Why: isolate the portaled Activity leaf so split siblings stay hidden; workspace renders pass null.
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

          {/* Browser panes: only the active pane mounts so inactive webviews park rather than keep hidden guest renderers alive. */}
          <div
            className={`relative flex-1 min-h-0 overflow-hidden ${
              activeTabType !== 'browser' ? 'hidden' : ''
            }`}
          >
            {workspaceSurfaces.map((workspace) => {
              const browserTabs = browserTabsByWorktree[workspace.id] ?? []
              // Why: strict '=== terminal' (not !== settings) so browser panes hide on the tasks page too.
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
                confirmNativeWindowClose()
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

// Why: overlay pins each once-rendered pane (keyed by pane id) to its group's CSS anchor, so cross-group moves avoid terminal remount / webview reload.
// React.memo: Terminal.tsx re-renders on unrelated store updates; memoize so this surface only re-renders on its own prop changes.
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
      // Why: paintable-but-hidden webviews must be inert so they stay unreachable by Tab / assistive tech.
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
