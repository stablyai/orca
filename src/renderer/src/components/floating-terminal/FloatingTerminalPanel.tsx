/* eslint-disable max-lines -- Why: the floating panel owns window chrome,
 * resizing, orchestration setup, and mixed terminal/browser/editor tab
 * handling in one surface so the floating worktree does not drift from the
 * main tab model while still keeping the DOM-mounted panes local. */
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { FileText, Globe, Minus, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import BrowserPane from '@/components/browser-pane/BrowserPane'
import EmulatorPane from '@/components/emulator-pane/EmulatorPane'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import TabBar from '@/components/tab-bar/TabBar'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useShortcutKeyDetails, type ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
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
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
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
  matchKeybindingDigitIndex,
  type KeybindingActionId,
  type KeybindingContext,
  type KeybindingMatchOptions,
  type PhysicalModifierToken
} from '../../../../shared/keybindings'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../shared/modifier-double-tap-detector'
import type {
  BrowserTab as BrowserTabState,
  Tab,
  TabGroup,
  TerminalTab
} from '../../../../shared/types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import { FloatingTerminalOrchestrationDialog } from './FloatingTerminalOrchestrationDialog'
import { FloatingTerminalResizeHandles } from './FloatingTerminalResizeHandles'
import { FloatingTerminalWindowControls } from './FloatingTerminalWindowControls'
export { FloatingTerminalToggleButton } from './FloatingTerminalToggleButton'
import {
  anchorFloatingTerminalPanelBounds,
  clampFloatingTerminalBounds,
  getDefaultFloatingTerminalCommittedBounds,
  getDefaultFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds,
  persistFloatingTerminalPanelBounds,
  readPersistedFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelCommittedBounds,
  resolveFloatingTerminalPanelBounds,
  shouldReconcileFloatingTerminalPanelBounds,
  type FloatingTerminalPanelBounds,
  type FloatingTerminalPanelCommittedBounds,
  type FloatingTerminalPanelBoundsSource
} from './floating-terminal-panel-bounds'
import { translate } from '@/i18n/i18n'
import { consumeFloatingTerminalOpenMaximizedIntent } from '@/lib/floating-terminal'
const EMPTY_TERMINAL_TABS: TerminalTab[] = []
const EMPTY_BROWSER_TABS: BrowserTabState[] = []
const EMPTY_GROUPS: TabGroup[] = []
const EMPTY_UNIFIED_TABS: Tab[] = []
const LOCAL_RUNTIME_SETTINGS = { activeRuntimeEnvironmentId: null } as const

const EditorPanel = lazy(() => import('@/components/editor/EditorPanel'))

type FloatingTerminalPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  tourInteractionSnapshot?: FloatingWorkspaceTourInteractionSnapshot | null | undefined
}

type FloatingWorkspaceTourInteractionSnapshot = {
  wasPreviouslyInteracted?: boolean
  persisted?: Promise<void>
  recordFeatureInteractionForTour: boolean
}

type FloatingPanelShortcutInput = Partial<
  Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>
> &
  Pick<KeyboardEvent, 'target'> & { doubleTapModifier?: PhysicalModifierToken }

const FLOATING_TERMINAL_NO_DRAG_SELECTOR =
  'button,input,textarea,select,[role="menuitem"],[data-testid="sortable-tab"],[data-floating-terminal-no-drag]'
const FLOATING_TERMINAL_SHORTCUT_SURFACE_SELECTOR = '[data-floating-terminal-shortcut-surface]'

type FloatingTerminalPanelBoundsState = {
  committedBounds: FloatingTerminalPanelCommittedBounds
  renderedBounds: FloatingTerminalPanelBounds
  source: FloatingTerminalPanelBoundsSource
}

function isFloatingTerminalDragTarget(target: EventTarget): boolean {
  return !(target instanceof HTMLElement && target.closest(FLOATING_TERMINAL_NO_DRAG_SELECTOR))
}

function readInitialPanelBounds(): FloatingTerminalPanelBoundsState {
  const defaultCommittedBounds = getDefaultFloatingTerminalCommittedBounds()
  const defaultRenderedBounds = getDefaultFloatingTerminalBounds()
  const persistedBounds = readPersistedFloatingTerminalPanelBounds()
  return persistedBounds
    ? {
        committedBounds: persistedBounds,
        renderedBounds: shouldReconcileFloatingTerminalPanelBounds('user')
          ? resolveFloatingTerminalPanelBounds(persistedBounds, 'user')
          : resolveFloatingTerminalPanelCommittedBounds(persistedBounds),
        source: 'user'
      }
    : {
        committedBounds: defaultCommittedBounds,
        renderedBounds: defaultRenderedBounds,
        source: 'default'
      }
}

function areFloatingTerminalPanelCommittedBoundsEqual(
  left: FloatingTerminalPanelCommittedBounds | null,
  right: FloatingTerminalPanelCommittedBounds
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right)
}

function setFloatingTerminalInputFocusedInMain(focused: boolean): void {
  const setInputFocused = window.api.ui.setFloatingTerminalInputFocused
  // Why: dev reloads can pair a new renderer with an older preload; losing this
  // shortcut mirror should not take down the whole React tree.
  if (typeof setInputFocused !== 'function') {
    return
  }
  setInputFocused(focused)
}

export function FloatingTerminalPanel({
  open,
  onOpenChange,
  tourInteractionSnapshot
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
  const closeUnifiedTab = useAppStore((s) => s.closeUnifiedTab)
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const activateTab = useAppStore((s) => s.activateTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const setTabPaneExpanded = useAppStore((s) => s.setTabPaneExpanded)
  const makePreviewFilePermanent = useAppStore((s) => s.makePreviewFilePermanent)
  const pinFile = useAppStore((s) => s.pinFile)
  const openFile = useAppStore((s) => s.openFile)
  const browserDefaultUrl = useAppStore((s) => s.browserDefaultUrl)
  const floatingTerminalCwd = useAppStore((s) => s.settings?.floatingTerminalCwd ?? '')
  const generatedTabTitlesEnabled = useAppStore((s) => s.settings?.tabAutoGenerateTitle === true)
  const newTerminalShortcut = useShortcutKeyDetails('tab.newTerminal')
  const newBrowserShortcut = useShortcutKeyDetails('tab.newBrowser')
  const newMarkdownShortcut = useShortcutKeyDetails('tab.newMarkdown')
  const openMarkdownShortcut = useShortcutKeyDetails('tab.openMarkdown')
  const closeShortcut = useShortcutKeyDetails('tab.close')

  const [cwd, setCwd] = useState<string | null>(null)
  const [markdownCwd, setMarkdownCwd] = useState<string | null>(null)
  const initialBoundsStateRef = useRef<FloatingTerminalPanelBoundsState | null>(null)
  if (initialBoundsStateRef.current === null) {
    initialBoundsStateRef.current = readInitialPanelBounds()
  }
  const boundsSourceRef = useRef<FloatingTerminalPanelBoundsSource>(
    initialBoundsStateRef.current.source
  )
  const committedBoundsRef = useRef<FloatingTerminalPanelCommittedBounds>(
    initialBoundsStateRef.current.committedBounds
  )
  const [bounds, setBounds] = useState(initialBoundsStateRef.current.renderedBounds)
  const [maximized, setMaximized] = useState(false)
  const [orchestrationDialogOpen, setOrchestrationDialogOpen] = useState(false)
  const [showOrchestrationSetup, setShowOrchestrationSetup] = useState(
    () => !hasOrchestrationSetupMarker() && !isOrchestrationSetupDismissed()
  )
  const restoreBoundsRef = useRef<FloatingTerminalPanelBoundsState | null>(null)
  const stagedBoundsRef = useRef<FloatingTerminalPanelBounds | null>(null)
  const lastPersistedBoundsRef = useRef<FloatingTerminalPanelCommittedBounds | null>(
    initialBoundsStateRef.current.source === 'user'
      ? initialBoundsStateRef.current.committedBounds
      : null
  )
  const pendingEditorCloseQueueRef = useRef<string[]>([])
  const saveDialogFileIdRef = useRef<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const doubleTapDetectorRef = useRef<ModifierDoubleTapDetector | null>(null)
  if (!doubleTapDetectorRef.current) {
    doubleTapDetectorRef.current = new ModifierDoubleTapDetector()
  }
  const shortcutFocusFrameRef = useRef<number | null>(null)
  const shortcutFocusTimeoutRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    bounds: FloatingTerminalPanelBounds
    moved: boolean
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
    activeTab &&
    activeTab.contentType !== 'terminal' &&
    activeTab.contentType !== 'browser' &&
    activeTab.contentType !== 'simulator'
      ? activeTab.id
      : null
  const activeEditorFileId =
    activeTab &&
    activeTab.contentType !== 'terminal' &&
    activeTab.contentType !== 'browser' &&
    activeTab.contentType !== 'simulator'
      ? activeTab.entityId
      : null
  const terminalTabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs])
  const terminalItems = useMemo<(TerminalTab & { unifiedTabId: string })[]>(
    () =>
      groupTabs
        .filter((tab) => tab.contentType === 'terminal')
        .flatMap((tab): (TerminalTab & { unifiedTabId: string })[] => {
          const terminalTab = terminalTabById.get(tab.entityId)
          if (!terminalTab) {
            return []
          }

          return [
            {
              ...terminalTab,
              unifiedTabId: tab.id,
              title: resolveUnifiedTabLabel(
                {
                  ...tab,
                  quickCommandLabel: tab.quickCommandLabel ?? terminalTab.quickCommandLabel,
                  generatedLabel: tab.generatedLabel ?? terminalTab.generatedTitle
                },
                generatedTabTitlesEnabled,
                tab.label
              ),
              generatedTitle: terminalTab.generatedTitle ?? tab.generatedLabel ?? null,
              quickCommandLabel: terminalTab.quickCommandLabel ?? tab.quickCommandLabel ?? null,
              customTitle: tab.customLabel ?? terminalTab.customTitle,
              color: tab.color ?? terminalTab.color
            }
          ]
        }),
    [generatedTabTitlesEnabled, groupTabs, terminalTabById]
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
        .filter(
          (tab) =>
            tab.contentType !== 'terminal' &&
            tab.contentType !== 'browser' &&
            tab.contentType !== 'simulator'
        )
        .map((tab) => {
          const file = floatingFiles.find((candidate) => candidate.id === tab.entityId)
          return file ? { ...file, tabId: tab.id } : null
        })
        .filter((file): file is OpenFile & { tabId: string } => file !== null),
    [floatingFiles, groupTabs]
  )
  const simulatorItems = useMemo(
    () => groupTabs.filter((tab) => tab.contentType === 'simulator'),
    [groupTabs]
  )
  // Why: restored sessions can retain unified tabs whose backing records are
  // gone; the empty landing should follow what the user can see.
  const hasVisibleFloatingTabs =
    terminalItems.length > 0 ||
    browserItems.length > 0 ||
    editorItems.length > 0 ||
    simulatorItems.length > 0
  const visibleFloatingItemCount =
    terminalItems.length + browserItems.length + editorItems.length + simulatorItems.length
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
  const visibleFloatingTabOrder = useMemo(
    () =>
      tabBarOrder.filter((visibleId) => {
        const tab = resolveGroupTabFromVisibleId(groupTabs, visibleId)
        if (!tab) {
          return false
        }
        if (tab.contentType === 'terminal') {
          return terminalItems.some((item) => item.unifiedTabId === tab.id)
        }
        if (tab.contentType === 'browser') {
          return browserItems.some((item) => item.tabId === tab.id)
        }
        if (tab.contentType === 'simulator') {
          return simulatorItems.some((item) => item.id === tab.id)
        }
        return editorItems.some((item) => item.tabId === tab.id)
      }),
    [browserItems, editorItems, groupTabs, simulatorItems, tabBarOrder, terminalItems]
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
        : activeTab?.contentType === 'simulator'
          ? 'simulator'
          : 'editor'

  useContextualTour('floating-workspace', open, 'floating_workspace_visible', {
    recordFeatureInteraction: tourInteractionSnapshot?.recordFeatureInteractionForTour ?? false,
    featureInteractionPersisted: tourInteractionSnapshot?.persisted,
    wasFeaturePreviouslyInteracted: tourInteractionSnapshot?.wasPreviouslyInteracted
  })

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

  const persistUserBounds = useCallback(
    (nextBounds: FloatingTerminalPanelCommittedBounds): void => {
      if (
        areFloatingTerminalPanelCommittedBoundsEqual(lastPersistedBoundsRef.current, nextBounds)
      ) {
        return
      }
      lastPersistedBoundsRef.current = nextBounds
      persistFloatingTerminalPanelBounds(nextBounds)
    },
    []
  )

  const previewUserBounds = useCallback((nextBounds: FloatingTerminalPanelBounds): void => {
    const clampedBounds = clampFloatingTerminalBounds(nextBounds)
    stagedBoundsRef.current = clampedBounds
    setBounds(clampedBounds)
  }, [])

  const commitUserBounds = useCallback(
    (nextBounds: FloatingTerminalPanelBounds | null = stagedBoundsRef.current): void => {
      if (!nextBounds) {
        return
      }
      const clampedBounds = clampFloatingTerminalBounds(nextBounds)
      stagedBoundsRef.current = null
      setBounds(clampedBounds)
      const anchoredBounds = anchorFloatingTerminalPanelBounds(clampedBounds)
      if (!anchoredBounds) {
        return
      }
      committedBoundsRef.current = anchoredBounds
      boundsSourceRef.current = 'user'
      persistUserBounds(anchoredBounds)
    },
    [persistUserBounds]
  )

  const reconcileBounds = useCallback((): void => {
    if (maximized) {
      setBounds(getMaximizedFloatingTerminalBounds())
      return
    }
    setBounds((currentBounds) => {
      const source = boundsSourceRef.current
      if (!shouldReconcileFloatingTerminalPanelBounds(source)) {
        return currentBounds
      }
      const nextBounds = resolveFloatingTerminalPanelBounds(committedBoundsRef.current, source)
      return nextBounds
    })
  }, [maximized])

  useLayoutEffect(() => {
    // Why: Electron can mount before final renderer dimensions are known; default
    // bounds should re-anchor before paint while saved user bounds wait for a usable viewport.
    reconcileBounds()
  }, [reconcileBounds])

  useEffect(() => {
    const handleResize = (): void => reconcileBounds()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [reconcileBounds])

  useEffect(() => {
    let cancelled = false
    void window.api.app
      .getFloatingTerminalCwd({
        path: floatingTerminalCwd
      })
      .then((nextCwd) => {
        if (!cancelled) {
          setCwd(nextCwd)
        }
      })
    return () => {
      cancelled = true
    }
  }, [floatingTerminalCwd])

  useEffect(() => {
    let cancelled = false
    void window.api.app.getFloatingMarkdownDirectory().then((nextMarkdownCwd) => {
      if (!cancelled) {
        setMarkdownCwd(nextMarkdownCwd)
      }
    })
    return () => {
      cancelled = true
    }
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
      if (mountedRef.current) {
        setShowOrchestrationSetup(!isOrcaCliAvailableOnPath(status))
      }
    } catch {
      if (mountedRef.current) {
        setShowOrchestrationSetup(true)
      }
    }
  }, [mountedRef])

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
        title: translate(
          'auto.components.floating.terminal.FloatingTerminalPanel.8b14ba6c17',
          'New Browser Tab'
        ),
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
        const fileInfo = await createUntitledMarkdownFileWithTemplateSelection(
          markdownCwd,
          FLOATING_TERMINAL_WORKTREE_ID,
          getConnectionId(FLOATING_TERMINAL_WORKTREE_ID) ?? undefined,
          LOCAL_RUNTIME_SETTINGS
        )
        if (!fileInfo) {
          return
        }
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
        .filter((item): item is Tab => item !== null && !item.isPinned)
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
        } else if (item.contentType === 'simulator') {
          closeUnifiedTab(item.id)
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
    [activeGroup, closeBrowserTab, closeFile, closeTab, closeUnifiedTab, queueEditorCloseRequests]
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
          (tab) =>
            tab.contentType !== 'terminal' &&
            tab.contentType !== 'browser' &&
            // Why: simulator tabs are not files; "Close All Files" must leave
            // the Mobile Emulator open like terminal/browser tabs do.
            tab.contentType !== 'simulator' &&
            !tab.isPinned
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

  const cancelShortcutFocusFrame = useCallback((): void => {
    if (shortcutFocusFrameRef.current !== null) {
      cancelAnimationFrame(shortcutFocusFrameRef.current)
      shortcutFocusFrameRef.current = null
    }
    if (shortcutFocusTimeoutRef.current !== null) {
      window.clearTimeout(shortcutFocusTimeoutRef.current)
      shortcutFocusTimeoutRef.current = null
    }
  }, [])

  const setPanelNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: the deferred shortcut focus targets this panel and must stop
      // when the panel root leaves the DOM.
      if (!node) {
        cancelShortcutFocusFrame()
      }
      panelRef.current = node
    },
    [cancelShortcutFocusFrame]
  )

  const focusPanelForShortcutsAfterClose = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }
    cancelShortcutFocusFrame()
    const focusPanel = (): void => {
      shortcutFocusFrameRef.current = null
      shortcutFocusTimeoutRef.current = null
      focusPanelForShortcuts(false)
    }
    if (typeof window.requestAnimationFrame === 'function') {
      shortcutFocusFrameRef.current = window.requestAnimationFrame(focusPanel)
      return
    }
    shortcutFocusTimeoutRef.current = window.setTimeout(focusPanel, 0)
  }, [cancelShortcutFocusFrame, focusPanelForShortcuts])

  const setFloatingTerminalInputFocused = useCallback((target: EventTarget | null): void => {
    setFloatingTerminalInputFocusedInMain(isFloatingWorkspaceTerminalInputTarget(target))
  }, [])

  const toggleMaximized = useCallback(() => {
    if (maximized) {
      const restoredState = restoreBoundsRef.current ?? {
        committedBounds: getDefaultFloatingTerminalCommittedBounds(),
        renderedBounds: getDefaultFloatingTerminalBounds(),
        source: 'default' as const
      }
      restoreBoundsRef.current = null
      boundsSourceRef.current = restoredState.source
      committedBoundsRef.current = restoredState.committedBounds
      const restoredBounds = shouldReconcileFloatingTerminalPanelBounds(restoredState.source)
        ? resolveFloatingTerminalPanelBounds(restoredState.committedBounds, restoredState.source)
        : restoredState.renderedBounds
      stagedBoundsRef.current = null
      setBounds(restoredBounds)
      setMaximized(false)
      return
    }
    restoreBoundsRef.current = {
      committedBounds: committedBoundsRef.current,
      renderedBounds: bounds,
      source: boundsSourceRef.current
    }
    stagedBoundsRef.current = null
    setBounds(getMaximizedFloatingTerminalBounds())
    setMaximized(true)
  }, [bounds, maximized])

  const maximizePanel = useCallback(() => {
    // Why: idempotent maximize used by the open-into-maximized intent. Unlike
    // toggleMaximized it never restores, and only stashes restore bounds on the
    // first transition so a redundant call cannot clobber the saved size.
    if (maximized) {
      return
    }
    restoreBoundsRef.current = {
      committedBounds: committedBoundsRef.current,
      renderedBounds: bounds,
      source: boundsSourceRef.current
    }
    stagedBoundsRef.current = null
    setBounds(getMaximizedFloatingTerminalBounds())
    setMaximized(true)
  }, [bounds, maximized])

  useEffect(() => {
    // Why: when App opens the panel via Cmd+Opt+Shift+A while it was closed,
    // it records a one-shot intent; honor it once the panel is open so it
    // starts maximized regardless of its last saved size.
    if (open && consumeFloatingTerminalOpenMaximizedIntent()) {
      maximizePanel()
    }
  }, [open, maximizePanel])

  const handleFloatingPanelShortcutAction = useCallback(
    (input: FloatingPanelShortcutInput, consume: () => void): boolean => {
      const state = useAppStore.getState()
      const platform = getShortcutPlatform()
      const terminalShortcutPolicy = state.settings?.terminalShortcutPolicy
      const isFloatingTerminalInput = isFloatingWorkspaceTerminalInputTarget(input.target)
      const context: KeybindingContext = input.doubleTapModifier
        ? 'app'
        : isFloatingTerminalInput
          ? 'terminal'
          : 'app'
      const matchOptions: KeybindingMatchOptions = {
        context,
        terminalShortcutPolicy
      }
      // Floating panel chrome owns these controls even when xterm has DOM focus;
      // keep the rest of the shortcut table in terminal context for terminal-first.
      const floatingChromeMatchOptions: KeybindingMatchOptions =
        isFloatingTerminalInput && terminalShortcutPolicy === 'terminal-first'
          ? { context: 'app', terminalShortcutPolicy }
          : matchOptions
      const matches = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, input, platform, state.keybindings, matchOptions)
      const matchesFloatingChrome = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(
          actionId,
          input,
          platform,
          state.keybindings,
          floatingChromeMatchOptions
        )

      if (matches('tab.newTerminal')) {
        consume()
        createFloatingTerminalTab()
        return true
      }
      if (matches('tab.newBrowser')) {
        consume()
        createFloatingBrowserTab()
        return true
      }
      if (matches('tab.newMarkdown')) {
        consume()
        createFloatingMarkdownTab()
        return true
      }
      if (matches('tab.openMarkdown')) {
        consume()
        openFloatingMarkdownTab()
        return true
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
        return true
      }
      if (matchesFloatingChrome('tab.rename') && activeTab) {
        consume()
        state.setRenamingTabId(activeTab.id)
        return true
      }
      const selectedTabIndex = matchKeybindingDigitIndex(
        'tab.selectByIndex',
        input,
        platform,
        state.keybindings,
        matchOptions
      )
      if (selectedTabIndex !== null) {
        const visibleId = visibleFloatingTabOrder[selectedTabIndex]
        if (!visibleId) {
          return false
        }
        consume()
        activateFloatingItem(visibleId)
        return true
      }
      if (matchesFloatingChrome('floatingWorkspace.maximize')) {
        consume()
        toggleMaximized()
        return true
      }
      if (matchesFloatingChrome('floatingWorkspace.minimize')) {
        consume()
        onOpenChange(false)
        return true
      }
      return false
    },
    [
      activeClosableTab,
      activeTab,
      activateFloatingItem,
      closeFloatingItem,
      createFloatingBrowserTab,
      createFloatingMarkdownTab,
      createFloatingTerminalTab,
      focusPanelForShortcutsAfterClose,
      onOpenChange,
      openFloatingMarkdownTab,
      toggleMaximized,
      visibleFloatingItemCount,
      visibleFloatingTabOrder
    ]
  )

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
      const terminalShortcutPolicy = state.settings?.terminalShortcutPolicy
      const isFloatingTerminalInput = isFloatingWorkspaceTerminalInputTarget(event.target)
      const context: KeybindingContext = isFloatingTerminalInput ? 'terminal' : 'app'
      const matchOptions: KeybindingMatchOptions = {
        context,
        terminalShortcutPolicy
      }
      const floatingChromeMatchOptions: KeybindingMatchOptions =
        isFloatingTerminalInput && terminalShortcutPolicy === 'terminal-first'
          ? { context: 'app', terminalShortcutPolicy }
          : matchOptions
      const nativeEvent = event.nativeEvent
      const isFloatingChromeShortcut =
        keybindingMatchesAction(
          'tab.rename',
          nativeEvent,
          platform,
          state.keybindings,
          floatingChromeMatchOptions
        ) ||
        matchKeybindingDigitIndex(
          'tab.selectByIndex',
          nativeEvent,
          platform,
          state.keybindings,
          matchOptions
        ) !== null ||
        keybindingMatchesAction(
          'floatingWorkspace.maximize',
          nativeEvent,
          platform,
          state.keybindings,
          floatingChromeMatchOptions
        ) ||
        keybindingMatchesAction(
          'floatingWorkspace.minimize',
          nativeEvent,
          platform,
          state.keybindings,
          floatingChromeMatchOptions
        )

      if (
        !isFloatingWorkspacePanelShortcut(
          nativeEvent,
          platform,
          panelRef.current,
          state.keybindings,
          matchOptions
        ) &&
        !isFloatingChromeShortcut
      ) {
        return
      }

      handleFloatingPanelShortcutAction(nativeEvent, () => event.preventDefault())
    },
    [handleFloatingPanelShortcutAction, open]
  )

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return
    }

    const isPanelFocused = (): boolean => {
      const panel = panelRef.current
      const active = document.activeElement
      return Boolean(panel && active instanceof HTMLElement && panel.contains(active))
    }

    const handleFloatingPanelKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return
      }
      if (!isPanelFocused()) {
        doubleTapDetectorRef.current?.reset()
        return
      }

      const detected = doubleTapDetectorRef.current?.process(
        toModifierDoubleTapEvent({
          type: 'keyDown',
          code: event.code,
          key: event.key,
          shift: event.shiftKey,
          control: event.ctrlKey,
          alt: event.altKey,
          meta: event.metaKey,
          isAutoRepeat: event.repeat
        }),
        Date.now()
      )
      if (event.repeat) {
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

      if (
        detected &&
        handleFloatingPanelShortcutAction(
          { doubleTapModifier: detected.modifier, target: event.target },
          consume
        )
      ) {
        return
      }

      if (handleFloatingPanelShortcutAction(event, consume)) {
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

    const handleFloatingPanelKeyUp = (event: KeyboardEvent): void => {
      if (!isPanelFocused()) {
        doubleTapDetectorRef.current?.reset()
        return
      }
      doubleTapDetectorRef.current?.process(
        toModifierDoubleTapEvent({
          type: 'keyUp',
          code: event.code,
          key: event.key,
          shift: event.shiftKey,
          control: event.ctrlKey,
          alt: event.altKey,
          meta: event.metaKey
        }),
        Date.now()
      )
    }

    const handleFloatingPanelBlur = (): void => doubleTapDetectorRef.current?.reset()

    // Why: the main Terminal view is not mounted on Landing/Settings, but the
    // floating workspace must still own its tab shortcuts while it has focus.
    window.addEventListener('keydown', handleFloatingPanelKeyDown, { capture: true })
    window.addEventListener('keyup', handleFloatingPanelKeyUp, { capture: true })
    window.addEventListener('blur', handleFloatingPanelBlur)
    return () => {
      window.removeEventListener('keydown', handleFloatingPanelKeyDown, { capture: true })
      window.removeEventListener('keyup', handleFloatingPanelKeyUp, { capture: true })
      window.removeEventListener('blur', handleFloatingPanelBlur)
      doubleTapDetectorRef.current?.reset()
    }
  }, [handleFloatingPanelShortcutAction, open])

  useEffect(() => {
    if (!open) {
      setFloatingTerminalInputFocusedInMain(false)
    }
    return () => setFloatingTerminalInputFocusedInMain(false)
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
      setFloatingTerminalInputFocusedInMain(false)
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
      setFloatingTerminalInputFocusedInMain(false)
      active.blur()
    }

    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [open])
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
      bounds,
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleDragMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (dx === 0 && dy === 0) {
      return
    }
    drag.moved = true
    previewUserBounds({
      ...drag.bounds,
      left: drag.bounds.left + dx,
      top: drag.bounds.top + dy
    })
  }

  const handleDragEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    if (drag.moved) {
      commitUserBounds()
    }
    dragRef.current = null
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
    // Why: root notification cards use z-40; keep the floating workspace below
    // them so alerts are never hidden behind an open terminal panel.
    // Drop shadow on the outer shell, border on an inner shell — mixing both on
    // one rounded node made corners look stubby. Floating tabs skip their top
    // border so the titlebar curve stays clean.
    <div
      ref={setPanelNode}
      data-floating-terminal-panel
      aria-hidden={!open}
      tabIndex={-1}
      className={`fixed z-30 flex min-h-[280px] min-w-[420px] rounded-lg bg-transparent text-card-foreground shadow-[0_4px_12px_rgba(0,0,0,0.16),0_24px_64px_rgba(0,0,0,0.32)] outline-none dark:shadow-[0_8px_20px_rgba(0,0,0,0.35),0_28px_72px_rgba(0,0,0,0.58)] ${open ? 'opacity-100' : 'invisible pointer-events-none opacity-0'}`}
      style={{
        visibility: open ? 'visible' : 'hidden',
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height
      }}
      onMouseUp={(event) => {
        if (maximized || !stagedBoundsRef.current) {
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        commitUserBounds({ ...stagedBoundsRef.current, width: rect.width, height: rect.height })
      }}
      onFocusCapture={(event) => setFloatingTerminalInputFocused(event.target)}
      onBlurCapture={(event) => setFloatingTerminalInputFocused(event.relatedTarget)}
      onKeyDownCapture={handleShortcutSurfaceKeyDown}
    >
      <div className="relative flex h-full w-full min-h-0 flex-col overflow-hidden rounded-lg border border-black/14 bg-card dark:border-white/14">
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
              newTabMenuOrder="markdown-first"
              onSetCustomTitle={setTabCustomTitle}
              onSetTabColor={setTabColor}
              onTogglePaneExpand={(tabId) =>
                setTabPaneExpanded(tabId, expandedPaneByTabId[tabId] !== true)
              }
              editorFiles={editorItems}
              browserTabs={browserItems}
              activeFileId={activeEditorUnifiedId}
              activeBrowserTabId={activeBrowserId}
              activeSimulatorTabId={activeTab?.contentType === 'simulator' ? activeTab.id : null}
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
              onMakePreviewFilePermanent={makePreviewFilePermanent}
              onPinFile={pinFile}
              tabBarOrder={tabBarOrder}
              tabStripChrome="floating-panel"
            />
          </div>
          <FloatingTerminalWindowControls
            maximized={maximized}
            onToggleMaximized={toggleMaximized}
            onMinimize={() => onOpenChange(false)}
          />
        </div>

        <div
          className="relative min-h-0 flex-1 overflow-hidden bg-background"
          data-contextual-tour-target={
            hasVisibleFloatingTabs ? 'floating-workspace-surface' : undefined
          }
        >
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
                      // Why: the closed panel is only CSS-hidden, so gate
                      // visibility on `open` too. This routes the floating
                      // terminal through the standard hidden-terminal
                      // suspend/resume path: no live WebGL context (or glyph
                      // atlas to corrupt) while hidden, and the resume on
                      // reopen rebuilds the renderer from scratch.
                      isVisible={isActive && open}
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
          {simulatorItems.map((tab) => {
            const isActive = tab.id === activeTab?.id
            return (
              <div
                key={tab.id}
                className={isActive ? 'absolute inset-0 flex' : 'absolute inset-0 hidden'}
                aria-hidden={!isActive}
              >
                <EmulatorPane tab={tab} worktreeId={tab.worktreeId} isActive={open && isActive} />
              </div>
            )
          })}
          {activeEditorFile ? (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {translate(
                      'auto.components.floating.terminal.FloatingTerminalPanel.d6b563ae24',
                      'Loading editor...'
                    )}
                  </div>
                }
              >
                {/* Why: floating workspace markdown is scratch/local context,
                    not a repo review surface that should expose agent notes. */}
                <EditorPanel
                  activeFileId={activeEditorFile.id}
                  activeViewStateId={activeEditorUnifiedId}
                  markdownAnnotationsEnabled={false}
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
              newTerminalShortcut={newTerminalShortcut}
              newBrowserShortcut={newBrowserShortcut}
              newMarkdownShortcut={newMarkdownShortcut}
              openMarkdownShortcut={openMarkdownShortcut}
              closeShortcut={closeShortcut}
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
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.floating.terminal.FloatingTerminalPanel.2a3c5ddf5e',
                  'Enable orchestration'
                )}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {translate(
                  'auto.components.floating.terminal.FloatingTerminalPanel.8cf80db43b',
                  'Set up the Orca CLI and agent skill so agents can coordinate through Orca.'
                )}
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
                {translate(
                  'auto.components.floating.terminal.FloatingTerminalPanel.adc281394d',
                  'Dismiss'
                )}
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="flex-1"
                onClick={() => setOrchestrationDialogOpen(true)}
              >
                {translate(
                  'auto.components.floating.terminal.FloatingTerminalPanel.bbc177f98f',
                  'Enable'
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {!maximized && (
        <FloatingTerminalResizeHandles
          bounds={bounds}
          onPreviewBounds={previewUserBounds}
          onCommitBounds={commitUserBounds}
        />
      )}
      <FloatingTerminalOrchestrationDialog
        open={orchestrationDialogOpen}
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
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.floating.terminal.FloatingTerminalPanel.690b6fb98a',
                'Unsaved Changes'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {saveDialogFile
                ? translate(
                    'auto.components.floating.terminal.FloatingTerminalPanel.5ddc688c52',
                    '"{{value0}}" has unsaved changes. Do you want to save before closing?',
                    { value0: saveDialogFile.relativePath.split('/').pop() }
                  )
                : translate(
                    'auto.components.floating.terminal.FloatingTerminalPanel.b085fb58b5',
                    'This file has unsaved changes.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFloatingSaveDialogCancel}
            >
              {translate(
                'auto.components.floating.terminal.FloatingTerminalPanel.e7bf09d4d4',
                'Cancel'
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFloatingSaveDialogDiscard}
            >
              {translate(
                'auto.components.floating.terminal.FloatingTerminalPanel.918c2139f3',
                "Don't Save"
              )}
            </Button>
            <Button type="button" size="sm" onClick={handleFloatingSaveDialogSave}>
              {translate(
                'auto.components.floating.terminal.FloatingTerminalPanel.da508bd7f5',
                'Save'
              )}
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
  newTerminalShortcut,
  newBrowserShortcut,
  newMarkdownShortcut,
  openMarkdownShortcut,
  closeShortcut
}: {
  onNewTerminal: () => void
  onNewMarkdown: () => void
  onOpenMarkdown: () => void
  onNewBrowser: () => void
  onClose: () => void
  onFocusPanel: () => void
  newTerminalShortcut: ShortcutKeyComboDetails
  newBrowserShortcut: ShortcutKeyComboDetails
  newMarkdownShortcut: ShortcutKeyComboDetails
  openMarkdownShortcut: ShortcutKeyComboDetails
  closeShortcut: ShortcutKeyComboDetails
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
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          data-contextual-tour-target="floating-workspace-new-terminal"
          onClick={onNewTerminal}
        >
          <TerminalSquare className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.3215fc73e9',
              'New Terminal'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={newTerminalShortcut} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          data-contextual-tour-target="floating-workspace-new-markdown"
          onClick={onNewMarkdown}
        >
          <FileText className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.629528690b',
              'New Markdown Note'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={newMarkdownShortcut} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onOpenMarkdown}
        >
          <FileText className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.88ffb502e5',
              'Open Markdown Note'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={openMarkdownShortcut} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onNewBrowser}
        >
          <Globe className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.8b07759314',
              'New Browser'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={newBrowserShortcut} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onClose}
        >
          <Minus className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.fc1042e92b',
              'Minimize'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={closeShortcut} />
        </Button>
      </div>
    </div>
  )
}

function FloatingEmptyStateShortcut({
  shortcut
}: {
  shortcut: ShortcutKeyComboDetails
}): React.JSX.Element {
  if (shortcut.keys.length === 0) {
    return <span aria-hidden />
  }
  return (
    <ShortcutKeyCombo
      keys={shortcut.keys}
      doubleTap={shortcut.doubleTap}
      className="self-center justify-self-end opacity-90 [&>span]:text-foreground"
      separatorClassName="mx-0 text-[9px] text-foreground"
    />
  )
}
