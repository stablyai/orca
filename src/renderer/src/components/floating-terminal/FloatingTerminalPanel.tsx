/* eslint-disable max-lines -- Why: the floating panel owns window chrome,
 * resizing, orchestration setup, and mixed terminal/browser/editor tab
 * handling in one surface so the floating worktree does not drift from the
 * main tab model while still keeping the DOM-mounted panes local. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileText, Globe, Minus, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import TabGroupSplitLayout from '@/components/tab-group/TabGroupSplitLayout'
import TerminalPaneOverlayLayer from '@/components/terminal-pane/TerminalPaneOverlayLayer'
import BrowserPaneOverlayLayer from '@/components/browser-pane/BrowserPaneOverlayLayer'
import EmulatorPaneOverlayLayer from '@/components/emulator-pane/EmulatorPaneOverlayLayer'
import { isTerminalImeInputContextRefreshing } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
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
import {
  ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT,
  type EditorRequestFileCloseDetail
} from '@/components/editor/editor-autosave'
import { destroyWorkspaceWebviews } from '@/store/slices/browser-webview-cleanup'
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
import type { Tab } from '../../../../shared/types'
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
import { selectFloatingTerminalPanelInputs } from './floating-terminal-panel-inputs'
const LOCAL_RUNTIME_SETTINGS = { activeRuntimeEnvironmentId: null } as const

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

// Why: every tab strip root (terminal/browser/markdown) carries data-tab-id.
// Excluding it from the titlebar drag region lets dnd-kit own the pointer for
// tab reordering instead of starting a floating-window move.
const FLOATING_TERMINAL_NO_DRAG_SELECTOR =
  'button,input,textarea,select,[role="menuitem"],[data-tab-id],[data-testid="sortable-tab"],[data-floating-terminal-no-drag]'
const FLOATING_TERMINAL_SHORTCUT_SURFACE_SELECTOR = '[data-floating-terminal-shortcut-surface]'

type FloatingTerminalPanelBoundsState = {
  committedBounds: FloatingTerminalPanelCommittedBounds
  renderedBounds: FloatingTerminalPanelBounds
  source: FloatingTerminalPanelBoundsSource
}

function resolveDragTargetElement(target: EventTarget): Element | null {
  // Why: pointer targets can be SVG icons or text nodes nested inside a tab
  // root, neither of which is an HTMLElement. Normalize any Node to its nearest
  // Element (text nodes via parentElement) so closest() can match a
  // [data-tab-id] ancestor. typeof guards keep this safe in non-DOM contexts.
  if (typeof Element !== 'undefined' && target instanceof Element) {
    return target
  }
  if (typeof Node !== 'undefined' && target instanceof Node) {
    return target.parentElement
  }
  // Fallback for hosts/targets that duck-type the DOM (e.g. test doubles).
  const candidate = target as { closest?: unknown; parentElement?: Element | null }
  if (typeof candidate.closest === 'function') {
    return candidate as unknown as Element
  }
  return candidate.parentElement ?? null
}

function isFloatingTerminalDragTarget(target: EventTarget): boolean {
  return !resolveDragTargetElement(target)?.closest(FLOATING_TERMINAL_NO_DRAG_SELECTOR)
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
  const { tabs, browserTabs, groups, unifiedTabs, floatingFiles } = useAppStore(
    selectFloatingTerminalPanelInputs
  )
  const reconcileWorktreeTabModel = useAppStore((s) => s.reconcileWorktreeTabModel)
  const createTab = useAppStore((s) => s.createTab)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const closeBrowserTab = useAppStore((s) => s.closeBrowserTab)
  const closeFile = useAppStore((s) => s.closeFile)
  const closeUnifiedTab = useAppStore((s) => s.closeUnifiedTab)
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const activateTab = useAppStore((s) => s.activateTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const openFile = useAppStore((s) => s.openFile)
  const browserDefaultUrl = useAppStore((s) => s.browserDefaultUrl)
  const floatingTerminalCwd = useAppStore((s) => s.settings?.floatingTerminalCwd ?? '')
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
  const shouldRestorePanelFocusAfterWindowFocusRef = useRef(false)
  const doubleTapDetectorRef = useRef<ModifierDoubleTapDetector | null>(null)
  if (!doubleTapDetectorRef.current) {
    doubleTapDetectorRef.current = new ModifierDoubleTapDetector()
  }
  const shortcutFocusFrameRef = useRef<number | null>(null)
  const shortcutFocusTimeoutRef = useRef<number | null>(null)
  const reclaimTerminalInputOnWindowFocusRef = useRef<{
    helper: HTMLElement
    leafId: string | null
  } | null>(null)
  const mountedRef = useMountedRef()
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    bounds: FloatingTerminalPanelBounds
    moved: boolean
  } | null>(null)

  const layout = useAppStore((s) => s.layoutByWorktree[FLOATING_TERMINAL_WORKTREE_ID])
  const focusedGroupId = useAppStore(
    (s) => s.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  )

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === focusedGroupId) ?? groups[0] ?? null,
    [groups, focusedGroupId]
  )
  const activeTab = useMemo(() => {
    if (!activeGroup) {
      return null
    }
    return unifiedTabs.find((tab) => tab.id === activeGroup.activeTabId) ?? null
  }, [activeGroup, unifiedTabs])

  // Why: restored sessions can retain unified tabs whose backing terminal,
  // browser, or editor record is gone. Basing visibility on the raw unified
  // tab count would keep the empty landing hidden and paint a blank surface,
  // so derive the renderable set from tabs that still have a backing record.
  const floatingTerminalTabs = tabs
  const floatingBrowserTabs = browserTabs
  const renderableUnifiedTabs = useMemo(
    () =>
      unifiedTabs.filter((tab) => {
        if (tab.contentType === 'terminal') {
          return floatingTerminalTabs.some((candidate) => candidate.id === tab.entityId)
        }
        if (tab.contentType === 'browser') {
          return floatingBrowserTabs.some((candidate) => candidate.id === tab.entityId)
        }
        if (tab.contentType === 'simulator') {
          return true
        }
        // Why: mirror reconcileWorktreeTabModel — an open file with the same id
        // in another worktree must not make a stale floating editor tab look
        // renderable, so scope the match to the floating worktree.
        return floatingFiles.some((file) => file.id === tab.entityId)
      }),
    [unifiedTabs, floatingTerminalTabs, floatingBrowserTabs, floatingFiles]
  )
  const renderableTabIds = useMemo(
    () => new Set(renderableUnifiedTabs.map((tab) => tab.id)),
    [renderableUnifiedTabs]
  )
  const hasVisibleFloatingTabs = renderableUnifiedTabs.length > 0
  const visibleFloatingItemCount = renderableUnifiedTabs.length
  // Why: the active/group tab order can still reference a stale tab whose
  // backing record is gone. Resolve the active tab and selection order against
  // the renderable set so close/rename/select-by-index never target a tab the
  // surface does not paint.
  const renderableActiveTab =
    activeTab && renderableTabIds.has(activeTab.id) ? activeTab : (renderableUnifiedTabs[0] ?? null)
  const activeClosableTab = renderableActiveTab

  const visibleFloatingTabOrder = useMemo(
    () => (activeGroup?.tabOrder ?? []).filter((tabId) => renderableTabIds.has(tabId)),
    [activeGroup, renderableTabIds]
  )

  const activeTabType =
    renderableActiveTab?.contentType === 'browser'
      ? 'browser'
      : renderableActiveTab?.contentType === 'terminal'
        ? 'terminal'
        : renderableActiveTab?.contentType === 'simulator'
          ? 'simulator'
          : 'editor'

  const activeTerminalId =
    renderableActiveTab?.contentType === 'terminal' ? renderableActiveTab.entityId : null

  useContextualTour('floating-workspace', open, 'floating_workspace_visible', {
    recordFeatureInteraction: tourInteractionSnapshot?.recordFeatureInteractionForTour ?? false,
    featureInteractionPersisted: tourInteractionSnapshot?.persisted,
    wasFeaturePreviouslyInteracted: tourInteractionSnapshot?.wasPreviouslyInteracted
  })

  // Why: this panel only queues its own editor tabs, so unrelated workspace
  // file updates must not invalidate the hidden panel's close callbacks.
  const {
    saveDialogFileId,
    saveDialogFile,
    requestCloseFile,
    handleSaveDialogSave,
    handleSaveDialogDiscard,
    handleSaveDialogCancel
  } = useTerminalSaveDialog({ openFiles: floatingFiles, closeFile, markFileDirty })

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

  // Why: dirty editor closes triggered from the floating panel's split-group
  // tab strip (TabGroupPanel -> useTabGroupWorkspaceModel) dispatch the shared
  // request-file-close event. Terminal.tsx ignores floating-worktree events, so
  // the floating panel must route them through its own local save-dialog queue.
  useEffect(() => {
    const onRequestEditorClose = (event: Event): void => {
      const detail = (event as CustomEvent<EditorRequestFileCloseDetail>).detail
      if (!detail?.fileId || detail.worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
        return
      }
      queueEditorCloseRequests([detail.fileId])
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

  // Why: restored sessions can leave the floating worktree with unified tabs
  // whose backing terminal/editor/browser record is gone. The delegated
  // TabGroupPanel renders straight from the unified-tab model, so prune the
  // stale tabs (and repair the active tab/group/layout) when the panel opens or
  // its backing collections change — otherwise a mixed stale+valid state hands
  // a stale active tab and tab order to the split layout.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    reconcileWorktreeTabModel(FLOATING_TERMINAL_WORKTREE_ID)
  }, [
    open,
    reconcileWorktreeTabModel,
    unifiedTabs,
    floatingTerminalTabs,
    floatingBrowserTabs,
    floatingFiles
  ])

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
    focusTerminalTabSurface(activeTerminalId, null, {
      onImeRefocusSkipped: (active) =>
        setFloatingTerminalInputFocusedInMain(isFloatingWorkspaceTerminalInputTarget(active)),
      refreshImeContext: true
    })
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
    (tabId: string) => {
      const item = unifiedTabs.find((t) => t.id === tabId)
      if (!item) {
        return
      }
      activateTab(item.id)
      if (item.contentType === 'terminal') {
        setActiveTab(item.entityId)
        focusTerminalTabSurface(item.entityId)
      } else if (item.contentType === 'browser') {
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
    [activateTab, unifiedTabs, setActiveTab]
  )

  const createFloatingTerminalTab = useCallback(
    (shellOverride?: string) => {
      // Why: the floating workspace is a local scratchpad; a focused remote
      // runtime must not own tabs users keep there for manual SSH/tmux work.
      const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, activeGroup?.id, shellOverride, {
        activate: false
      })
      activateTab(tab.id)
      focusTerminalTabSurface(tab.id)
    },
    [activateTab, activeGroup, createTab]
  )

  const createFloatingBrowserTab = useCallback(() => {
    const url = browserDefaultUrl ?? 'about:blank'
    createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, url, {
      title: translate(
        'auto.components.floating.terminal.FloatingTerminalPanel.8b14ba6c17',
        'New Browser Tab'
      ),
      focusAddressBar: true,
      targetGroupId: activeGroup?.id,
      browserRuntimeEnvironmentId: null
    })
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
    (tabIds: string[]) => {
      const state = useAppStore.getState()
      const items = tabIds
        .map((tabId) => unifiedTabs.find((t) => t.id === tabId))
        .filter((item): item is Tab => item !== undefined && item !== null && !item.isPinned)
      if (items.length === 0) {
        return
      }
      const dirtyEditorFileIds: string[] = []
      for (const item of items) {
        if (item.contentType === 'terminal') {
          closeTab(item.entityId, { reason: 'cleanup' })
        } else if (item.contentType === 'browser') {
          destroyWorkspaceWebviews(state.browserPagesByWorkspace, item.entityId)
          closeBrowserTab(item.entityId)
          closeUnifiedTab(item.id)
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
    [closeBrowserTab, closeFile, closeTab, closeUnifiedTab, queueEditorCloseRequests, unifiedTabs]
  )

  const closeFloatingItem = useCallback(
    (tabId: string) => {
      closeFloatingItems([tabId])
    },
    [closeFloatingItems]
  )

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
      if (matchesFloatingChrome('tab.rename') && renderableActiveTab) {
        consume()
        state.setRenamingTabId(renderableActiveTab.id)
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
      renderableActiveTab,
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
      shouldRestorePanelFocusAfterWindowFocusRef.current = false
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
      reclaimTerminalInputOnWindowFocusRef.current = null
      if (!panel || !(active instanceof HTMLElement) || !panel.contains(active)) {
        shouldRestorePanelFocusAfterWindowFocusRef.current = false
        return
      }
      shouldRestorePanelFocusAfterWindowFocusRef.current = true
      // Why: browser webviews focus out-of-process and do not emit renderer
      // pointerdown events, so release floating ownership on renderer blur too.
      setFloatingTerminalInputFocusedInMain(false)
      if (isFloatingWorkspaceTerminalInputTarget(active)) {
        // Why: the terminal focus lifecycle preserves this exact helper across
        // app blur so macOS can rebuild its native input context on return.
        reclaimTerminalInputOnWindowFocusRef.current = {
          helper: active,
          leafId: active.closest('[data-leaf-id]')?.getAttribute('data-leaf-id') ?? null
        }
        return
      }
      active.blur()
    }
    const handleWindowFocus = (): void => {
      const shouldRestorePanelFocus = shouldRestorePanelFocusAfterWindowFocusRef.current
      shouldRestorePanelFocusAfterWindowFocusRef.current = false
      const reclaim = reclaimTerminalInputOnWindowFocusRef.current
      reclaimTerminalInputOnWindowFocusRef.current = null
      const panel = panelRef.current
      const active = document.activeElement
      if (
        panel &&
        active instanceof HTMLElement &&
        panel.contains(active) &&
        isFloatingWorkspaceTerminalInputTarget(active)
      ) {
        setFloatingTerminalInputFocusedInMain(true)
        return
      }
      if (reclaim && (active === null || active === document.body) && activeTerminalId) {
        if (reclaim.helper.isConnected && panel?.contains(reclaim.helper)) {
          // Why: TerminalPane owns exact-helper reclaim and IME refresh. Avoid
          // racing it with a second floating-layer blur/refocus cycle.
          return
        }
        // Why: only a helper that genuinely remounted while backgrounded needs
        // tab/leaf recovery; the shared TerminalPane owner cannot reclaim it.
        focusTerminalTabSurface(activeTerminalId, reclaim.leafId, {
          onlyIfFocusUnclaimed: true,
          onImeRefocusSkipped: (active) =>
            setFloatingTerminalInputFocusedInMain(isFloatingWorkspaceTerminalInputTarget(active)),
          refreshImeContext: true
        })
        return
      }
      if (!shouldRestorePanelFocus) {
        return
      }
      if (!panel || (active instanceof HTMLElement && panel.contains(active))) {
        return
      }
      // Why: macOS app switching can blur the floating panel without a click.
      // Restore panel ownership so Cmd/Ctrl+W cannot fall through to main tabs.
      focusPanelForShortcuts(false)
    }

    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
    return () => {
      reclaimTerminalInputOnWindowFocusRef.current = null
      shouldRestorePanelFocusAfterWindowFocusRef.current = false
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [activeTerminalId, focusPanelForShortcuts, open])
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
    // Why: sit above the z-40 notification cards so the floating workspace is
    // never buried behind them, but stay under the z-50 modal layer so its own
    // orchestration/save dialogs (and every app modal) still open above it.
    // Drop shadow on the outer shell, border on an inner shell — mixing both on
    // one rounded node made corners look stubby. Floating tabs skip their top
    // border so the titlebar curve stays clean.
    <div
      ref={setPanelNode}
      data-floating-terminal-panel
      aria-hidden={!open}
      tabIndex={-1}
      className={`fixed z-[45] flex min-h-[280px] min-w-[420px] rounded-lg bg-transparent text-card-foreground shadow-[0_4px_12px_rgba(0,0,0,0.16),0_24px_64px_rgba(0,0,0,0.32)] outline-none dark:shadow-[0_8px_20px_rgba(0,0,0,0.35),0_28px_72px_rgba(0,0,0,0.58)] ${open ? 'opacity-100' : 'invisible pointer-events-none opacity-0'}`}
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
      onBlurCapture={(event) => {
        // Why: keep terminal-first shortcut ownership latched during the
        // synchronous macOS IME refresh blur; refocus or its skip callback settles it.
        if (!isTerminalImeInputContextRefreshing(event.target)) {
          setFloatingTerminalInputFocused(event.relatedTarget)
        }
      }}
      onKeyDownCapture={handleShortcutSurfaceKeyDown}
    >
      <div className="relative flex h-full w-full min-h-0 flex-col overflow-hidden rounded-lg border border-black/14 bg-card dark:border-white/14">
        <div
          className="flex h-9 shrink-0 cursor-grab items-center border-b border-border bg-[var(--bg-titlebar,var(--card))] active:cursor-grabbing px-3 justify-between"
          data-floating-terminal-shortcut-surface
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onDoubleClick={handleTitlebarDoubleClick}
        >
          <span className="text-xs font-medium text-muted-foreground select-none">
            {translate('auto.components.floating.terminal.FloatingTerminalPanel.title', 'Terminal')}
          </span>
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
          {hasVisibleFloatingTabs && layout ? (
            <TabGroupSplitLayout
              layout={layout}
              worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
              focusedGroupId={focusedGroupId}
              isWorktreeActive={open}
            />
          ) : null}
          {hasVisibleFloatingTabs && cwd ? (
            <TerminalPaneOverlayLayer
              worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
              worktreePath={cwd}
              isWorktreeActive={open}
            />
          ) : null}
          {hasVisibleFloatingTabs ? (
            <>
              <BrowserPaneOverlayLayer
                worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                isWorktreeActive={open}
              />
              <EmulatorPaneOverlayLayer
                worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                isWorktreeActive={open}
              />
            </>
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
