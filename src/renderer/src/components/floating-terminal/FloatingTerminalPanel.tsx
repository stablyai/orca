/* eslint-disable max-lines -- Why: the floating panel owns window chrome,
 * resizing, orchestration setup, and mixed terminal/browser/editor tab
 * handling in one surface so the floating worktree does not drift from the
 * main tab model while still keeping the DOM-mounted panes local. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Globe, Minus, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import BrowserPane from '@/components/browser-pane/BrowserPane'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import TabBar from '@/components/tab-bar/TabBar'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { Button } from '@/components/ui/button'
import { useShortcutKeys } from '@/hooks/useShortcutLabel'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTerminalSaveDialog } from '@/components/terminal/useTerminalSaveDialog'
import { appendUniqueOpenFileIds } from '@/components/terminal/unsaved-close-queue'
import { getConnectionId } from '@/lib/connection-context'
import { createUntitledMarkdownFile } from '@/lib/create-untitled-markdown'
import { detectLanguage } from '@/lib/language-detect'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { isOrcaCliAvailableOnPath } from '@/lib/agent-skill-cli-prerequisite'
import {
  isFloatingWorkspacePanelShortcut,
  isFloatingWorkspaceTerminalInputTarget,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import {
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY,
  ORCHESTRATION_SETUP_STATE_EVENT,
  hasOrchestrationSetupMarker,
  isOrchestrationSetupDismissed,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { destroyWorkspaceWebviews } from '@/store/slices/browser-webview-cleanup'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab,
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingContext,
  type KeybindingMatchOptions
} from '../../../../shared/keybindings'
import type {
  BrowserTab as BrowserTabState,
  Tab,
  TabGroup,
  TerminalTab
} from '../../../../shared/types'
import { FloatingTerminalOrchestrationDialog } from './FloatingTerminalOrchestrationDialog'
import { FloatingTerminalResizeHandles } from './FloatingTerminalResizeHandles'
import { FloatingTerminalWindowControls } from './FloatingTerminalWindowControls'
export { FloatingTerminalToggleButton } from './FloatingTerminalToggleButton'
import {
  clampFloatingTerminalBounds,
  getDefaultFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds,
  type FloatingTerminalPanelBounds
} from './floating-terminal-panel-bounds'
const EMPTY_TERMINAL_TABS: TerminalTab[] = []
const EMPTY_BROWSER_TABS: BrowserTabState[] = []
const EMPTY_GROUPS: TabGroup[] = []
const EMPTY_UNIFIED_TABS: Tab[] = []
const LOCAL_RUNTIME_SETTINGS = { activeRuntimeEnvironmentId: null } as const

const EditorPanel = lazy(() => import('@/components/editor/EditorPanel'))

type FloatingTerminalPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const FLOATING_TERMINAL_NO_DRAG_SELECTOR =
  'button,input,textarea,select,[role="menuitem"],[data-testid="sortable-tab"],[data-floating-terminal-no-drag]'
const FLOATING_TERMINAL_SHORTCUT_SURFACE_SELECTOR = '[data-floating-terminal-shortcut-surface]'

function isFloatingTerminalDragTarget(target: EventTarget): boolean {
  return !(target instanceof HTMLElement && target.closest(FLOATING_TERMINAL_NO_DRAG_SELECTOR))
}

export function FloatingTerminalPanel({
  open,
  onOpenChange
}: FloatingTerminalPanelProps): React.JSX.Element | null {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const groupsByWorktree = useAppStore((s) => s.groupsByWorktree)
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const openFiles = useAppStore((s) => s.openFiles)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const createTab = useAppStore((s) => s.createTab)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const closeBrowserTab = useAppStore((s) => s.closeBrowserTab)
  const closeFile = useAppStore((s) => s.closeFile)
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const activateTab = useAppStore((s) => s.activateTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const setTabPaneExpanded = useAppStore((s) => s.setTabPaneExpanded)
  const pinFile = useAppStore((s) => s.pinFile)
  const openFile = useAppStore((s) => s.openFile)
  const browserDefaultUrl = useAppStore((s) => s.browserDefaultUrl)
  const floatingTerminalCwd = useAppStore((s) => s.settings?.floatingTerminalCwd ?? '')
  const newTerminalShortcutKeys = useShortcutKeys('tab.newTerminal')
  const newBrowserShortcutKeys = useShortcutKeys('tab.newBrowser')
  const newMarkdownShortcutKeys = useShortcutKeys('tab.newMarkdown')
  const openMarkdownShortcutKeys = useShortcutKeys('tab.openMarkdown')
  const closeShortcutKeys = useShortcutKeys('tab.close')

  const [cwd, setCwd] = useState<string | null>(null)
  const [markdownCwd, setMarkdownCwd] = useState<string | null>(null)
  const [bounds, setBounds] = useState(() => getDefaultFloatingTerminalBounds())
  const [maximized, setMaximized] = useState(false)
  const [orchestrationDialogOpen, setOrchestrationDialogOpen] = useState(false)
  const [showOrchestrationSetup, setShowOrchestrationSetup] = useState(
    () => !hasOrchestrationSetupMarker() && !isOrchestrationSetupDismissed()
  )
  const restoreBoundsRef = useRef<FloatingTerminalPanelBounds | null>(null)
  const normalizedInitialBoundsRef = useRef(false)
  const pendingEditorCloseQueueRef = useRef<string[]>([])
  const saveDialogFileIdRef = useRef<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    left: number
    top: number
  } | null>(null)

  const tabs = tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TERMINAL_TABS
  const browserTabs = browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_BROWSER_TABS
  const groups = groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_GROUPS
  const unifiedTabs = unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_UNIFIED_TABS
  const floatingFiles = useMemo(
    () => openFiles.filter((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID),
    [openFiles]
  )
  const activeGroup = useMemo(
    () =>
      groups.find((group) => group.activeTabId != null) ??
      (unifiedTabs[0]
        ? (groups.find((group) => group.id === unifiedTabs[0].groupId) ?? null)
        : null),
    [groups, unifiedTabs]
  )
  const groupTabs = useMemo(
    () => (activeGroup ? unifiedTabs.filter((tab) => tab.groupId === activeGroup.id) : unifiedTabs),
    [activeGroup, unifiedTabs]
  )
  const activeTab = useMemo(
    () =>
      (activeGroup?.activeTabId
        ? groupTabs.find((tab) => tab.id === activeGroup.activeTabId)
        : null) ??
      groupTabs[0] ??
      null,
    [activeGroup, groupTabs]
  )
  const activeTerminalId = activeTab?.contentType === 'terminal' ? activeTab.entityId : null
  const activeBrowserId = activeTab?.contentType === 'browser' ? activeTab.entityId : null
  const activeEditorUnifiedId =
    activeTab && activeTab.contentType !== 'terminal' && activeTab.contentType !== 'browser'
      ? activeTab.id
      : null
  const activeEditorFileId =
    activeTab && activeTab.contentType !== 'terminal' && activeTab.contentType !== 'browser'
      ? activeTab.entityId
      : null
  const terminalTabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs])
  const terminalItems = useMemo(
    () =>
      groupTabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => {
          const terminalTab = terminalTabById.get(tab.entityId)
          return terminalTab
            ? {
                ...terminalTab,
                unifiedTabId: tab.id,
                title: tab.label,
                customTitle: tab.customLabel ?? terminalTab.customTitle,
                color: tab.color ?? terminalTab.color
              }
            : null
        })
        .filter((tab): tab is TerminalTab & { unifiedTabId: string } => tab !== null),
    [groupTabs, terminalTabById]
  )
  const browserItems = useMemo(
    () =>
      groupTabs
        .filter((tab) => tab.contentType === 'browser')
        .map((tab) => {
          const browserTab = browserTabs.find((candidate) => candidate.id === tab.entityId)
          return browserTab ? { ...browserTab, tabId: tab.id } : null
        })
        .filter((tab): tab is BrowserTabState & { tabId: string } => tab !== null),
    [browserTabs, groupTabs]
  )
  const editorItems = useMemo(
    () =>
      groupTabs
        .filter((tab) => tab.contentType !== 'terminal' && tab.contentType !== 'browser')
        .map((tab) => {
          const file = floatingFiles.find((candidate) => candidate.id === tab.entityId)
          return file ? { ...file, tabId: tab.id } : null
        })
        .filter((file): file is OpenFile & { tabId: string } => file !== null),
    [floatingFiles, groupTabs]
  )
  // Why: restored sessions can retain unified tabs whose backing terminal/file/browser
  // records are gone; the empty landing should follow what the user can see.
  const hasVisibleFloatingTabs =
    terminalItems.length > 0 || browserItems.length > 0 || editorItems.length > 0
  const visibleFloatingItemCount = terminalItems.length + browserItems.length + editorItems.length
  const activeClosableTab = hasVisibleFloatingTabs ? activeTab : null
  const tabBarOrder = useMemo(
    () =>
      (activeGroup?.tabOrder ?? []).map((tabId) => {
        const tab = groupTabs.find((candidate) => candidate.id === tabId)
        return tab?.contentType === 'terminal' || tab?.contentType === 'browser'
          ? tab.entityId
          : tabId
      }),
    [activeGroup, groupTabs]
  )
  const activeBrowserTab = activeBrowserId
    ? (browserTabs.find((tab) => tab.id === activeBrowserId) ?? null)
    : null
  const activeEditorFile = activeEditorFileId
    ? (floatingFiles.find((file) => file.id === activeEditorFileId) ?? null)
    : null
  const activeTabType =
    activeTab?.contentType === 'browser'
      ? 'browser'
      : activeTab?.contentType === 'terminal'
        ? 'terminal'
        : 'editor'
  const {
    saveDialogFileId,
    saveDialogFile,
    requestCloseFile,
    handleSaveDialogSave,
    handleSaveDialogDiscard,
    handleSaveDialogCancel
  } = useTerminalSaveDialog({ openFiles, closeFile, markFileDirty })

  const getNextQueuedEditorClose = useCallback((): string | null => {
    while (pendingEditorCloseQueueRef.current.length > 0) {
      const fileId = pendingEditorCloseQueueRef.current[0]
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
    if (saveDialogFileIdRef.current !== null) {
      return
    }
    const nextFileId = getNextQueuedEditorClose()
    if (!nextFileId) {
      return
    }
    // Why: useTerminalSaveDialog only stores one file id. Mark the next id as
    // reserved before setting dialog state so same-tick bulk close requests
    // cannot overwrite it with a later dirty tab.
    saveDialogFileIdRef.current = nextFileId
    requestCloseFile(nextFileId)
  }, [getNextQueuedEditorClose, requestCloseFile])

  const queueEditorCloseRequests = useCallback(
    (fileIds: string[]) => {
      pendingEditorCloseQueueRef.current = appendUniqueOpenFileIds(
        pendingEditorCloseQueueRef.current,
        fileIds,
        new Set(useAppStore.getState().openFiles.map((file) => file.id))
      )
      advanceEditorCloseQueue()
    },
    [advanceEditorCloseQueue]
  )

  useEffect(() => {
    saveDialogFileIdRef.current = saveDialogFileId
    if (saveDialogFileId === null) {
      advanceEditorCloseQueue()
    }
  }, [advanceEditorCloseQueue, saveDialogFileId])

  const handleFloatingSaveDialogSave = useCallback(() => {
    const fileId = saveDialogFileIdRef.current
    if (fileId) {
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (queuedId) => queuedId !== fileId
      )
    }
    handleSaveDialogSave()
  }, [handleSaveDialogSave])

  const handleFloatingSaveDialogDiscard = useCallback(() => {
    const fileId = saveDialogFileIdRef.current
    if (fileId) {
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (queuedId) => queuedId !== fileId
      )
    }
    void Promise.resolve(handleSaveDialogDiscard())
  }, [handleSaveDialogDiscard])

  const handleFloatingSaveDialogCancel = useCallback(() => {
    pendingEditorCloseQueueRef.current = []
    handleSaveDialogCancel()
  }, [handleSaveDialogCancel])

  useEffect(() => {
    if (!open || normalizedInitialBoundsRef.current || typeof window === 'undefined') {
      return
    }
    normalizedInitialBoundsRef.current = true
    const rightGap = window.innerWidth - bounds.left - bounds.width
    if (rightGap > 160) {
      setBounds(getDefaultFloatingTerminalBounds())
    }
  }, [bounds.left, bounds.width, open])

  useEffect(() => {
    void window.api.app
      .getFloatingTerminalCwd({
        path: floatingTerminalCwd
      })
      .then(setCwd)
  }, [floatingTerminalCwd])

  useEffect(() => {
    void window.api.app.getFloatingMarkdownDirectory().then(setMarkdownCwd)
  }, [])

  useEffect(() => {
    if (!open || !activeTerminalId) {
      return
    }
    focusTerminalTabSurface(activeTerminalId)
  }, [activeTerminalId, open])

  useEffect(() => {
    if (!open || hasVisibleFloatingTabs) {
      return
    }
    // Why: opening an empty floating workspace from the global shortcut leaves
    // focus on the previous page; focus the panel so immediate tab shortcuts work.
    panelRef.current?.focus({ preventScroll: true })
  }, [hasVisibleFloatingTabs, open])

  const refreshOrchestrationSetupVisibility = useCallback(async (): Promise<void> => {
    if (isOrchestrationSetupDismissed()) {
      setShowOrchestrationSetup(false)
      return
    }
    if (!hasOrchestrationSetupMarker()) {
      setShowOrchestrationSetup(true)
      return
    }
    try {
      const status = await window.api.cli.getInstallStatus()
      setShowOrchestrationSetup(!isOrcaCliAvailableOnPath(status))
    } catch {
      setShowOrchestrationSetup(true)
    }
  }, [])

  useEffect(() => {
    if (open) {
      void refreshOrchestrationSetupVisibility()
    }
  }, [open, refreshOrchestrationSetupVisibility])

  useEffect(() => {
    const handleSetupStateChange = (): void => {
      void refreshOrchestrationSetupVisibility()
    }
    window.addEventListener(ORCHESTRATION_SETUP_STATE_EVENT, handleSetupStateChange)
    return () => {
      window.removeEventListener(ORCHESTRATION_SETUP_STATE_EVENT, handleSetupStateChange)
    }
  }, [refreshOrchestrationSetupVisibility])

  const activateFloatingItem = useCallback(
    (visibleId: string) => {
      const item = resolveGroupTabFromVisibleId(groupTabs, visibleId)
      if (!item) {
        return
      }
      activateTab(item.id)
      const runtimeEnvironmentId = useAppStore
        .getState()
        .settings?.activeRuntimeEnvironmentId?.trim()
      if (item.contentType === 'terminal') {
        if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
          void activateWebRuntimeSessionTab({
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            tabId: item.entityId,
            environmentId: runtimeEnvironmentId
          })
        }
        setActiveTab(item.entityId)
        focusTerminalTabSurface(item.entityId)
      } else if (item.contentType === 'browser') {
        if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
          void activateWebRuntimeSessionTab({
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            tabId: item.id,
            environmentId: runtimeEnvironmentId
          })
        }
        const workspace = useAppStore
          .getState()
          .browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find(
            (tab) => tab.id === item.entityId
          )
        if (workspace?.activePageId && window.api?.browser) {
          void window.api.browser.notifyActiveTabChanged({ browserPageId: workspace.activePageId })
        }
      }
    },
    [activateTab, groupTabs, setActiveTab]
  )

  const createFloatingTerminalTab = useCallback(
    (shellOverride?: string) => {
      void (async () => {
        if (
          await createWebRuntimeSessionTerminal({
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            targetGroupId: activeGroup?.id,
            command: shellOverride,
            activate: true,
            selectWorktree: false
          })
        ) {
          return
        }
        const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, activeGroup?.id, shellOverride, {
          activate: false
        })
        activateTab(tab.id)
        focusTerminalTabSurface(tab.id)
      })()
    },
    [activateTab, activeGroup, createTab]
  )

  const createFloatingBrowserTab = useCallback(() => {
    void (async () => {
      const url = browserDefaultUrl ?? 'about:blank'
      if (
        await createWebRuntimeSessionBrowserTab({
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          url,
          targetGroupId: activeGroup?.id,
          selectWorktree: false
        })
      ) {
        return
      }
      createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, url, {
        title: 'New Browser Tab',
        focusAddressBar: true,
        targetGroupId: activeGroup?.id
      })
    })()
  }, [activeGroup, browserDefaultUrl, createBrowserTab])

  const createFloatingMarkdownTab = useCallback(() => {
    if (!markdownCwd) {
      return
    }
    void (async () => {
      try {
        const fileInfo = await createUntitledMarkdownFile(
          markdownCwd,
          FLOATING_TERMINAL_WORKTREE_ID,
          getConnectionId(FLOATING_TERMINAL_WORKTREE_ID) ?? undefined,
          LOCAL_RUNTIME_SETTINGS
        )
        openFile(fileInfo, {
          preview: false,
          targetGroupId: activeGroup?.id,
          suppressActiveRuntimeFallback: true
        })
      } catch (err) {
        toast.error(extractIpcErrorMessage(err, 'Failed to create untitled markdown file.'))
      }
    })()
  }, [activeGroup, markdownCwd, openFile])

  const openFloatingMarkdownTab = useCallback(() => {
    void (async () => {
      try {
        const document = await window.api.app.pickFloatingMarkdownDocument()
        if (!document) {
          return
        }
        openFile(
          {
            filePath: document.filePath,
            relativePath: document.relativePath,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: detectLanguage(document.relativePath),
            mode: 'edit',
            runtimeEnvironmentId: null
          },
          {
            preview: false,
            targetGroupId: activeGroup?.id,
            suppressActiveRuntimeFallback: true
          }
        )
      } catch (err) {
        toast.error(extractIpcErrorMessage(err, 'Failed to open markdown file.'))
      }
    })()
  }, [activeGroup, openFile])

  const closeFloatingItems = useCallback(
    (visibleIds: string[]) => {
      const state = useAppStore.getState()
      const currentGroupTabs = activeGroup
        ? (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
            (tab) => tab.groupId === activeGroup.id
          )
        : (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [])
      const items = visibleIds
        .map((visibleId) => resolveGroupTabFromVisibleId(currentGroupTabs, visibleId))
        .filter((item): item is Tab => item !== null)
      if (items.length === 0) {
        return
      }
      const dirtyEditorFileIds: string[] = []
      const runtimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
      for (const item of items) {
        if (
          (item.contentType === 'terminal' || item.contentType === 'browser') &&
          isWebRuntimeSessionActive(runtimeEnvironmentId)
        ) {
          // Why: paired web clients mirror host-owned tabs; ask the runtime to
          // close the host tab instead of deleting the local mirror directly.
          void closeWebRuntimeSessionTab({
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            tabId: item.contentType === 'browser' ? item.id : item.entityId,
            environmentId: runtimeEnvironmentId
          })
          continue
        }
        if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'browser') {
          destroyWorkspaceWebviews(state.browserPagesByWorkspace, item.entityId)
          closeBrowserTab(item.entityId)
        } else {
          const file = state.openFiles.find((candidate) => candidate.id === item.entityId)
          if (file?.isDirty) {
            dirtyEditorFileIds.push(item.entityId)
            continue
          }
          closeFile(item.entityId)
        }
      }
      if (dirtyEditorFileIds.length > 0) {
        queueEditorCloseRequests(dirtyEditorFileIds)
      }
    },
    [activeGroup, closeBrowserTab, closeFile, closeTab, queueEditorCloseRequests]
  )

  const closeFloatingItem = useCallback(
    (visibleId: string) => {
      closeFloatingItems([visibleId])
    },
    [closeFloatingItems]
  )

  const closeOthers = useCallback(
    (visibleId: string) => {
      const state = useAppStore.getState()
      const currentGroupTabs = activeGroup
        ? (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
            (tab) => tab.groupId === activeGroup.id
          )
        : (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [])
      const item = resolveGroupTabFromVisibleId(currentGroupTabs, visibleId)
      if (!item) {
        return
      }
      closeFloatingItems(
        currentGroupTabs.filter((tab) => tab.id !== item.id && !tab.isPinned).map((tab) => tab.id)
      )
    },
    [activeGroup, closeFloatingItems]
  )

  const closeToRight = useCallback(
    (visibleId: string) => {
      const state = useAppStore.getState()
      const currentGroup = activeGroup
        ? state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find(
            (group) => group.id === activeGroup.id
          )
        : null
      const currentGroupTabs = currentGroup
        ? (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
            (tab) => tab.groupId === currentGroup.id
          )
        : (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [])
      const item = resolveGroupTabFromVisibleId(currentGroupTabs, visibleId)
      if (!item || !currentGroup) {
        return
      }
      const index = currentGroup.tabOrder.indexOf(item.id)
      if (index === -1) {
        return
      }
      const tabById = new Map(currentGroupTabs.map((tab) => [tab.id, tab]))
      closeFloatingItems(
        currentGroup.tabOrder.slice(index + 1).filter((tabId) => {
          const tab = tabById.get(tabId)
          return tab ? !tab.isPinned : false
        })
      )
    },
    [activeGroup, closeFloatingItems]
  )

  const closeAllFiles = useCallback(() => {
    const state = useAppStore.getState()
    const currentGroupTabs = activeGroup
      ? (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
          (tab) => tab.groupId === activeGroup.id
        )
      : (state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [])
    closeFloatingItems(
      currentGroupTabs
        .filter(
          (tab) => tab.contentType !== 'terminal' && tab.contentType !== 'browser' && !tab.isPinned
        )
        .map((tab) => tab.id)
    )
  }, [activeGroup, closeFloatingItems])

  const focusPanelForShortcuts = useCallback((preserveExistingPanelFocus = true) => {
    const active = document.activeElement
    if (
      preserveExistingPanelFocus &&
      active instanceof HTMLElement &&
      active.closest('[data-floating-terminal-panel]') !== null
    ) {
      // Why: dragging the titlebar while xterm/editor already has focus should
      // not steal the typing target just to keep panel shortcuts scoped.
      return
    }
    panelRef.current?.focus({ preventScroll: true })
  }, [])

  const focusPanelForShortcutsAfterClose = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }
    const focusPanel = (): void => focusPanelForShortcuts(false)
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusPanel)
      return
    }
    globalThis.setTimeout(focusPanel, 0)
  }, [focusPanelForShortcuts])

  const setFloatingTerminalInputFocused = useCallback((target: EventTarget | null): void => {
    window.api.ui.setFloatingTerminalInputFocused(isFloatingWorkspaceTerminalInputTarget(target))
  }, [])

  const handleShortcutSurfaceKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!open || event.defaultPrevented || event.repeat) {
        return
      }
      const target = event.target
      if (
        !(target instanceof HTMLElement) ||
        (target !== panelRef.current &&
          target.closest(FLOATING_TERMINAL_SHORTCUT_SURFACE_SELECTOR) === null)
      ) {
        return
      }

      const state = useAppStore.getState()
      const platform = getShortcutPlatform()
      const context: KeybindingContext = isFloatingWorkspaceTerminalInputTarget(event.target)
        ? 'terminal'
        : 'app'
      const matchOptions: KeybindingMatchOptions = {
        context,
        terminalShortcutPolicy: state.settings?.terminalShortcutPolicy
      }
      const nativeEvent = event.nativeEvent
      const matches = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, nativeEvent, platform, state.keybindings, matchOptions)

      if (
        !isFloatingWorkspacePanelShortcut(
          nativeEvent,
          platform,
          panelRef.current,
          state.keybindings,
          matchOptions
        )
      ) {
        return
      }

      if (matches('tab.newTerminal')) {
        event.preventDefault()
        createFloatingTerminalTab()
        return
      }
      if (matches('tab.newBrowser')) {
        event.preventDefault()
        createFloatingBrowserTab()
        return
      }
      if (matches('tab.newMarkdown')) {
        event.preventDefault()
        createFloatingMarkdownTab()
        return
      }
      if (matches('tab.openMarkdown')) {
        event.preventDefault()
        openFloatingMarkdownTab()
        return
      }
      if (matches('tab.close')) {
        event.preventDefault()
        if (activeClosableTab) {
          closeFloatingItem(activeClosableTab.id)
          if (visibleFloatingItemCount <= 1) {
            // Why: closing the final xterm removes the focused textarea; keep
            // the empty floating workspace as the owner for the next Cmd/Ctrl+T.
            focusPanelForShortcutsAfterClose()
          }
        } else {
          onOpenChange(false)
        }
      }
    },
    [
      activeClosableTab,
      closeFloatingItem,
      createFloatingBrowserTab,
      createFloatingMarkdownTab,
      createFloatingTerminalTab,
      focusPanelForShortcutsAfterClose,
      onOpenChange,
      openFloatingMarkdownTab,
      open,
      visibleFloatingItemCount
    ]
  )

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return
    }

    const handleFloatingPanelKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) {
        return
      }
      const panel = panelRef.current
      const active = document.activeElement
      if (!panel || !(active instanceof HTMLElement) || !panel.contains(active)) {
        return
      }

      const state = useAppStore.getState()
      const context: KeybindingContext = isFloatingWorkspaceTerminalInputTarget(event.target)
        ? 'terminal'
        : 'app'
      const matches = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, event, getShortcutPlatform(), state.keybindings, {
          context,
          terminalShortcutPolicy: state.settings?.terminalShortcutPolicy
        })
      const consume = (): void => {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
      }

      if (matches('tab.newTerminal')) {
        consume()
        createFloatingTerminalTab()
        return
      }
      if (matches('tab.newBrowser')) {
        consume()
        createFloatingBrowserTab()
        return
      }
      if (matches('tab.newMarkdown')) {
        consume()
        createFloatingMarkdownTab()
        return
      }
      if (matches('tab.openMarkdown')) {
        consume()
        openFloatingMarkdownTab()
        return
      }
      if (matches('tab.close')) {
        consume()
        if (activeClosableTab) {
          closeFloatingItem(activeClosableTab.id)
          if (visibleFloatingItemCount <= 1) {
            // Why: closing the final xterm removes the focused textarea; keep
            // the empty floating workspace as the owner for the next Cmd/Ctrl+T.
            focusPanelForShortcutsAfterClose()
          }
        } else {
          onOpenChange(false)
        }
        return
      }

      const switchSameTypeDirection = matches('tab.nextSameType')
        ? 1
        : matches('tab.previousSameType')
          ? -1
          : null
      const switchAllTypesDirection = matches('tab.nextAllTypes')
        ? 1
        : matches('tab.previousAllTypes')
          ? -1
          : null
      if (switchSameTypeDirection !== null || switchAllTypesDirection !== null) {
        consume()
        switchFloatingWorkspaceTab(
          useAppStore.getState(),
          switchAllTypesDirection ?? switchSameTypeDirection ?? 1,
          switchAllTypesDirection !== null ? 'all-types' : 'same-type'
        )
        return
      }

      const terminalTabDirection = matches('tab.nextTerminal')
        ? 1
        : matches('tab.previousTerminal')
          ? -1
          : null
      if (terminalTabDirection !== null) {
        consume()
        switchFloatingWorkspaceTab(useAppStore.getState(), terminalTabDirection, 'terminal')
      }
    }

    // Why: the main Terminal view is not mounted on Landing/Settings, but the
    // floating workspace must still own its tab shortcuts while it has focus.
    window.addEventListener('keydown', handleFloatingPanelKeyDown, { capture: true })
    return () =>
      window.removeEventListener('keydown', handleFloatingPanelKeyDown, { capture: true })
  }, [
    activeClosableTab,
    closeFloatingItem,
    createFloatingBrowserTab,
    createFloatingMarkdownTab,
    createFloatingTerminalTab,
    focusPanelForShortcutsAfterClose,
    onOpenChange,
    openFloatingMarkdownTab,
    open,
    visibleFloatingItemCount
  ])

  useEffect(() => {
    if (!open) {
      window.api.ui.setFloatingTerminalInputFocused(false)
    }
    return () => window.api.ui.setFloatingTerminalInputFocused(false)
  }, [open])

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return
    }

    const handleOutsidePointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current
      if (!panel || !(event.target instanceof Node) || panel.contains(event.target)) {
        return
      }
      window.api.ui.setFloatingTerminalInputFocused(false)
      const active = document.activeElement
      if (active instanceof HTMLElement && panel.contains(active)) {
        // Why: regular tab strip items are non-focusable, so clicking them can
        // leave xterm's hidden textarea focused unless we explicitly release it.
        active.blur()
      }
    }
    const handleWindowBlur = (): void => {
      const panel = panelRef.current
      const active = document.activeElement
      if (!panel || !(active instanceof HTMLElement) || !panel.contains(active)) {
        return
      }
      // Why: browser webviews focus out-of-process and do not emit renderer
      // pointerdown events, so release floating ownership on renderer blur too.
      window.api.ui.setFloatingTerminalInputFocused(false)
      active.blur()
    }

    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [open])

  const toggleMaximized = useCallback(() => {
    setMaximized((current) => {
      if (current) {
        setBounds(restoreBoundsRef.current ?? getDefaultFloatingTerminalBounds())
        restoreBoundsRef.current = null
        return false
      }
      restoreBoundsRef.current = bounds
      setBounds(getMaximizedFloatingTerminalBounds())
      return true
    })
  }, [bounds])

  const handleDragStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (maximized) {
      return
    }
    if (event.button !== 0) {
      return
    }
    const target = event.target
    if (!isFloatingTerminalDragTarget(target)) {
      return
    }
    // Why: clicking the draggable titlebar should make the floating workspace
    // own shortcuts even when the main app is still on Landing.
    focusPanelForShortcuts()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: bounds.left,
      top: bounds.top
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleDragMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    setBounds((prev) =>
      clampFloatingTerminalBounds({
        ...prev,
        left: drag.left + event.clientX - drag.startX,
        top: drag.top + event.clientY - drag.startY
      })
    )
  }

  const handleDragEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }

  const handleTitlebarDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !isFloatingTerminalDragTarget(event.target)) {
      return
    }
    event.preventDefault()
    toggleMaximized()
  }

  const dismissOrchestrationSetup = useCallback(() => {
    localStorage.setItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY, '1')
    setShowOrchestrationSetup(false)
    notifyOrchestrationSetupStateChanged()
  }, [])

  return (
    <div
      ref={panelRef}
      data-floating-terminal-panel
      aria-hidden={!open}
      tabIndex={-1}
      className={`fixed z-50 flex min-h-[280px] min-w-[420px] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] outline-none ${open ? 'opacity-100' : 'invisible pointer-events-none opacity-0'}`}
      style={{
        visibility: open ? 'visible' : 'hidden',
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height
      }}
      onMouseUp={(event) => {
        if (maximized) {
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        setBounds((prev) =>
          clampFloatingTerminalBounds({ ...prev, width: rect.width, height: rect.height })
        )
      }}
      onFocusCapture={(event) => setFloatingTerminalInputFocused(event.target)}
      onBlurCapture={(event) => setFloatingTerminalInputFocused(event.relatedTarget)}
      onKeyDownCapture={handleShortcutSurfaceKeyDown}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex h-9 shrink-0 cursor-grab items-center border-b border-border bg-[var(--bg-titlebar,var(--card))] active:cursor-grabbing"
          data-floating-terminal-shortcut-surface
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onDoubleClick={handleTitlebarDoubleClick}
        >
          <div className="flex h-full min-w-0 flex-1">
            <TabBar
              tabs={terminalItems}
              activeTabId={activeTerminalId}
              worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
              expandedPaneByTabId={expandedPaneByTabId}
              onActivate={activateFloatingItem}
              onClose={closeFloatingItem}
              onCloseOthers={closeOthers}
              onCloseToRight={closeToRight}
              onNewTerminalTab={() => createFloatingTerminalTab()}
              onNewTerminalWithShell={createFloatingTerminalTab}
              onNewBrowserTab={createFloatingBrowserTab}
              onNewFileTab={createFloatingMarkdownTab}
              onOpenFileTab={openFloatingMarkdownTab}
              onSetCustomTitle={setTabCustomTitle}
              onSetTabColor={setTabColor}
              onTogglePaneExpand={(tabId) =>
                setTabPaneExpanded(tabId, expandedPaneByTabId[tabId] !== true)
              }
              editorFiles={editorItems}
              browserTabs={browserItems}
              activeFileId={activeEditorUnifiedId}
              activeBrowserTabId={activeBrowserId}
              activeTabType={activeTabType}
              onActivateFile={activateFloatingItem}
              onCloseFile={closeFloatingItem}
              onActivateBrowserTab={activateFloatingItem}
              onCloseBrowserTab={closeFloatingItem}
              onDuplicateBrowserTab={(browserTabId) => {
                void (async () => {
                  const source = browserTabs.find((tab) => tab.id === browserTabId)
                  if (!source) {
                    return
                  }
                  if (
                    await createWebRuntimeSessionBrowserTab({
                      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
                      url: source.url,
                      profileId: source.sessionProfileId,
                      targetGroupId: activeGroup?.id,
                      selectWorktree: false
                    })
                  ) {
                    return
                  }
                  createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, source.url, {
                    title: source.title,
                    sessionProfileId: source.sessionProfileId,
                    targetGroupId: activeGroup?.id
                  })
                })()
              }}
              onCloseAllFiles={closeAllFiles}
              onPinFile={pinFile}
              tabBarOrder={tabBarOrder}
            />
          </div>
          <FloatingTerminalWindowControls
            maximized={maximized}
            onToggleMaximized={toggleMaximized}
            onMinimize={() => onOpenChange(false)}
          />
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
          {cwd
            ? tabs.map((tab) => {
                const isActive = tab.id === activeTerminalId
                return (
                  <div
                    key={`${tab.id}-${tab.generation ?? 0}`}
                    className={isActive ? 'absolute inset-0' : 'absolute inset-0 hidden'}
                    aria-hidden={!isActive}
                  >
                    <TerminalPane
                      tabId={tab.id}
                      worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                      cwd={cwd}
                      isActive={isActive}
                      isVisible={isActive}
                      onPtyExit={() => closeTab(tab.id)}
                      onCloseTab={() => closeFloatingItem(tab.id)}
                    />
                  </div>
                )
              })
            : null}
          {browserTabs.map((tab) => {
            const isActive = tab.id === activeBrowserTab?.id
            return (
              <div
                key={tab.id}
                className={isActive ? 'absolute inset-0 flex' : 'absolute inset-0 hidden'}
                aria-hidden={!isActive}
              >
                <BrowserPane browserTab={tab} isActive={open && isActive} />
              </div>
            )
          })}
          {activeEditorFile ? (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Loading editor...
                  </div>
                }
              >
                <EditorPanel
                  activeFileId={activeEditorFile.id}
                  activeViewStateId={activeEditorUnifiedId}
                />
              </Suspense>
            </div>
          ) : null}
          {!hasVisibleFloatingTabs ? (
            <FloatingTerminalEmptyState
              onNewTerminal={() => createFloatingTerminalTab()}
              onNewMarkdown={createFloatingMarkdownTab}
              onOpenMarkdown={openFloatingMarkdownTab}
              onNewBrowser={createFloatingBrowserTab}
              onClose={() => onOpenChange(false)}
              onFocusPanel={focusPanelForShortcuts}
              newTerminalShortcutKeys={newTerminalShortcutKeys}
              newBrowserShortcutKeys={newBrowserShortcutKeys}
              newMarkdownShortcutKeys={newMarkdownShortcutKeys}
              openMarkdownShortcutKeys={openMarkdownShortcutKeys}
              closeShortcutKeys={closeShortcutKeys}
            />
          ) : null}
        </div>
      </div>
      {showOrchestrationSetup && activeTabType === 'terminal' ? (
        <div
          className="absolute right-4 bottom-4 z-10 w-[280px] rounded-md border border-border/60 bg-card/95 p-3 text-card-foreground shadow-xs"
          data-floating-terminal-no-drag
        >
          <div className="space-y-2">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable orchestration</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Set up the Orca CLI and agent skill so agents can coordinate through Orca.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="flex-1"
                onClick={dismissOrchestrationSetup}
              >
                Dismiss
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="flex-1"
                onClick={() => setOrchestrationDialogOpen(true)}
              >
                Enable
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {!maximized && <FloatingTerminalResizeHandles bounds={bounds} setBounds={setBounds} />}
      <FloatingTerminalOrchestrationDialog
        open={orchestrationDialogOpen}
        activeTabId={activeTerminalId}
        onOpenChange={setOrchestrationDialogOpen}
        onSetupStateChange={() => void refreshOrchestrationSetupVisibility()}
      />
      <Dialog
        open={saveDialogFileId !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            handleFloatingSaveDialogCancel()
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Unsaved Changes</DialogTitle>
            <DialogDescription className="text-xs">
              {saveDialogFile
                ? `"${saveDialogFile.relativePath.split('/').pop()}" has unsaved changes. Do you want to save before closing?`
                : 'This file has unsaved changes.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFloatingSaveDialogCancel}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFloatingSaveDialogDiscard}
            >
              Don&apos;t Save
            </Button>
            <Button type="button" size="sm" onClick={handleFloatingSaveDialogSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FloatingTerminalEmptyState({
  onNewTerminal,
  onNewMarkdown,
  onOpenMarkdown,
  onNewBrowser,
  onClose,
  onFocusPanel,
  newTerminalShortcutKeys,
  newBrowserShortcutKeys,
  newMarkdownShortcutKeys,
  openMarkdownShortcutKeys,
  closeShortcutKeys
}: {
  onNewTerminal: () => void
  onNewMarkdown: () => void
  onOpenMarkdown: () => void
  onNewBrowser: () => void
  onClose: () => void
  onFocusPanel: () => void
  newTerminalShortcutKeys: string[]
  newBrowserShortcutKeys: string[]
  newMarkdownShortcutKeys: string[]
  openMarkdownShortcutKeys: string[]
  closeShortcutKeys: string[]
}): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      data-floating-terminal-empty-state
      data-floating-terminal-shortcut-surface
      onPointerDown={onFocusPanel}
    >
      <div className="flex w-[360px] flex-col items-center gap-1.5" data-floating-terminal-no-drag>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onNewTerminal}
        >
          <TerminalSquare className="size-3.5 opacity-80" />
          <span className="truncate text-left leading-none">New Terminal</span>
          <FloatingEmptyStateShortcut keys={newTerminalShortcutKeys} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onNewBrowser}
        >
          <Globe className="size-3.5 opacity-80" />
          <span className="truncate text-left leading-none">New Browser</span>
          <FloatingEmptyStateShortcut keys={newBrowserShortcutKeys} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onNewMarkdown}
        >
          <FileText className="size-3.5 opacity-80" />
          <span className="truncate text-left leading-none">New Markdown Note</span>
          <FloatingEmptyStateShortcut keys={newMarkdownShortcutKeys} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onOpenMarkdown}
        >
          <FileText className="size-3.5 opacity-80" />
          <span className="truncate text-left leading-none">Open Markdown Note</span>
          <FloatingEmptyStateShortcut keys={openMarkdownShortcutKeys} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onClose}
        >
          <Minus className="size-3.5 opacity-80" />
          <span className="truncate text-left leading-none">Minimize</span>
          <FloatingEmptyStateShortcut keys={closeShortcutKeys} />
        </Button>
      </div>
    </div>
  )
}

function FloatingEmptyStateShortcut({ keys }: { keys: string[] }): React.JSX.Element {
  if (keys.length === 0) {
    return <span aria-hidden />
  }
  return (
    <ShortcutKeyCombo
      keys={keys}
      className="self-center justify-self-end opacity-75"
      separatorClassName="mx-0 text-[9px] text-muted-foreground"
    />
  )
}
