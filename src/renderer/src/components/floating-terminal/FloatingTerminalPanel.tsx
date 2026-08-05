/* eslint-disable max-lines -- Why: the floating panel owns window chrome,
 * resizing, orchestration setup, and mixed terminal/browser/editor tab
 * handling in one surface so the floating worktree does not drift from the
 * main tab model while still keeping the DOM-mounted panes local. */
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { FileText, Globe, Minus, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import EmulatorPane from '@/components/emulator-pane/EmulatorPane'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import TabBar from '@/components/tab-bar/TabBar'
import { resolveGroupTabFromVisibleId } from '@/components/tab-group/tab-group-visible-id'
import TerminalPane, { type TerminalPaneHandle } from '@/components/terminal-pane/TerminalPane'
import { shouldDeferParkedPtyExitTabClose } from '@/components/terminal-pane/terminal-parked-tab-watchers'
import { useTerminalTabColdParking } from '@/components/terminal-pane/use-terminal-tab-cold-parking'
import { isTerminalPaneCloseChord } from '@/components/terminal-pane/terminal-shortcut-policy'
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
import { buildDuplicatedBrowserTabOptions } from '@/lib/duplicate-browser-tab-options'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { isOrcaCliAvailableOnPath } from '@/lib/agent-skill-cli-prerequisite'
import {
  countVisibleFloatingWorkspaceItems,
  isEventTargetInsideFloatingWorkspacePanel,
  isFloatingWorkspacePanelFocused,
  isFloatingWorkspaceTerminalInputTarget,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import {
  matchFloatingWorkspacePanelOwnedAction,
  matchFloatingWorkspacePanelShortcut,
  type FloatingWorkspacePanelOwnedAction
} from '@/lib/floating-workspace-shortcut-policy'
import {
  armFloatingPanelReclaimIntent,
  clearFloatingPanelReclaimIntent,
  consumeFloatingPanelReclaimIntent
} from '@/lib/floating-workspace-focus-reclaim'
import {
  FLOATING_WORKSPACE_GUEST_CLOSE_EVENT,
  FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT,
  type FloatingWorkspaceGuestCloseDetail,
  type FloatingWorkspaceGuestSelectIndexDetail
} from '@/lib/floating-workspace-guest-bridge'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { guardPinnedTabClose, resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
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
import { createTerminalPaneHandleRegistry } from './terminal-pane-handle-registry'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingContext,
  type KeybindingMatchOptions,
  type PhysicalModifierToken
} from '../../../../shared/keybindings'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../shared/modifier-double-tap-detector'
import type { BrowserTab as BrowserTabState, Tab, TerminalTab } from '../../../../shared/types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import { FloatingBrowserSlot } from './FloatingBrowserSlot'
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
const NO_ACTIVITY_TERMINAL_PORTALS = []

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

// Tri-state dispatch outcome: 'deferred' means "matched, but leave DOM propagation intact so the
// terminal pane's L3 handler closes the focused split pane" — callers must NOT consume it. Both
// 'handled' and 'deferred' stop L2's own directional dispatch; only 'unmatched' falls through.
type FloatingShortcutOutcome = 'handled' | 'deferred' | 'unmatched'

// What the panel claimed for one keydown, resolved once and then applied — see resolveFloatingPanelShortcut.
type FloatingPanelShortcutResolution =
  | { kind: 'create'; action: Exclude<FloatingWorkspacePanelOwnedAction, 'tab.close'> }
  | { kind: 'close'; focusedFloatingTerminal: boolean }
  | { kind: 'index'; index: number }
  | { kind: 'chrome'; action: KeybindingActionId }

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

// Last atomic focus payload sent to main; module-scoped so send-on-change dedupe survives re-renders.
let lastReportedFloatingFocus: { panelFocused: boolean; terminalFocused: boolean } | null = null
// The IPC fn the dedupe above is keyed to; if the preload surface swaps (HMR/version skew), re-emit.
let lastReportedFloatingFocusFn: unknown = null

// Single guarded reporter for both focus bits. `release === true` means the panel is
// explicitly losing keyboard ownership (outside pointer-down, close, unmount, window blur); otherwise both
// bits derive from the next focus/blur target. Enforces panel ⊇ terminal and emits one atomic payload on change.
function reportFloatingFocus(next: EventTarget | null, release = false): void {
  const setFloatingFocus = window.api.ui.setFloatingFocus
  // Why: dev reloads can pair a new renderer with an older preload; losing this
  // shortcut mirror should not take down the whole React tree.
  if (typeof setFloatingFocus !== 'function') {
    return
  }
  if (setFloatingFocus !== lastReportedFloatingFocusFn) {
    lastReportedFloatingFocus = null
    lastReportedFloatingFocusFn = setFloatingFocus
  }
  const terminalFocused = !release && isFloatingWorkspaceTerminalInputTarget(next)
  const panelFocused =
    !release && (terminalFocused || isEventTargetInsideFloatingWorkspacePanel(next))
  if (
    lastReportedFloatingFocus !== null &&
    lastReportedFloatingFocus.panelFocused === panelFocused &&
    lastReportedFloatingFocus.terminalFocused === terminalFocused
  ) {
    return
  }
  lastReportedFloatingFocus = { panelFocused, terminalFocused }
  setFloatingFocus({ panelFocused, terminalFocused })
}

// Reset the send-on-change dedupe (test-only): the mock setFloatingFocus keeps one identity across
// tests, so without this a prior test's last-reported payload would suppress the next test's first emit.
export function clearReportedFloatingFocusCache(): void {
  lastReportedFloatingFocus = null
  lastReportedFloatingFocusFn = null
}

export function FloatingTerminalPanel({
  open,
  onOpenChange,
  tourInteractionSnapshot
}: FloatingTerminalPanelProps): React.JSX.Element | null {
  const { tabs, browserTabs, groups, unifiedTabs, floatingFiles, expandedPaneByTabId } =
    useAppStore(selectFloatingTerminalPanelInputs)
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
  // A dirty editor's close defers to the save dialog and completes asynchronously (Save closes from
  // inside the editor), so park its emptying reclaim-arm check here and run it when the file
  // actually leaves the panel — otherwise this content type silently skips the reclaim.
  const pendingReclaimArmByFileIdRef = useRef<Map<string, () => void>>(new Map())
  const saveDialogFileIdRef = useRef<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Live imperative handles per floating terminal tab, so a double-tap-bound close (which L3's window
  // listener never resolves) can reach the same split-aware pane-close authority directly (F2/F-feas).
  // Its ref callbacks are cached per tab id so a parent render doesn't hand TerminalPane a new
  // function identity, which would make React detach (dropping the handle) and re-attach every render.
  // useState lazy init (not null-guarded ref write) keeps render pure for react-doctor.
  const [terminalPaneRegistry] = useState(() =>
    createTerminalPaneHandleRegistry<TerminalPaneHandle>()
  )
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
  const terminalAssignments = useMemo(() => {
    const assignments = new Map<string, { groupId: string; isActiveInGroup: boolean }>()
    for (const tab of unifiedTabs) {
      if (tab.contentType === 'terminal') {
        assignments.set(tab.entityId, {
          groupId: tab.groupId,
          isActiveInGroup: tab.entityId === activeTerminalId
        })
      }
    }
    return assignments
  }, [activeTerminalId, unifiedTabs])
  const parkedTerminalTabIds = useTerminalTabColdParking({
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    terminalTabs: tabs,
    assignments: terminalAssignments,
    isWorktreeActive: open,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals: NO_ACTIVITY_TERMINAL_PORTALS
  })
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
                  generatedLabel: tab.generatedLabel ?? terminalTab.generatedTitle,
                  agentRenamedLabel: tab.agentRenamedLabel ?? terminalTab.agentRenamedTitle
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
    // Cancel drops the whole queue, so no queued file will close — discard their deferred arms too.
    pendingReclaimArmByFileIdRef.current.clear()
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
      onImeRefocusSkipped: (active) => reportFloatingFocus(active),
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
    (visibleId: string) => {
      const item = resolveGroupTabFromVisibleId(groupTabs, visibleId)
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
    [activateTab, groupTabs, setActiveTab]
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
      for (const item of items) {
        if (item.contentType === 'terminal') {
          closeTab(item.entityId, { reason: 'cleanup' })
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

  // Single confirmed-close authority for one floating item; every content type routes through a pin
  // guard (terminals via closeTerminalTab's own), and a panel-owned emptying close arms the reclaim intent.
  const closeFloatingItemConfirmed = useCallback(
    (visibleId: string, options?: { guestOwned?: boolean }) => {
      const item = resolveGroupTabFromVisibleId(groupTabs, visibleId)
      if (!item) {
        return
      }
      // Capture focus ownership now — before any close/blur or pin dialog steals it (the destructive
      // DOM removal blurs the pane and would flip a live focus read to false).
      const panelOwnedNow = options?.guestOwned === true || isFloatingWorkspacePanelFocused()
      // Re-derive emptiness from live store at arm time, not from the pre-close render snapshot: a
      // concurrent create keeps the panel non-empty, and a no-op close (closeTerminalTab's !target
      // path fires onClosed without removing anything) leaves the count unchanged — arm on neither.
      const itemCountBeforeClose = countVisibleFloatingWorkspaceItems(useAppStore.getState())
      const armIfEmptying = (): void => {
        if (!panelOwnedNow) {
          return
        }
        const itemCountAfterClose = countVisibleFloatingWorkspaceItems(useAppStore.getState())
        if (itemCountAfterClose === 0 && itemCountAfterClose < itemCountBeforeClose) {
          armFloatingPanelReclaimIntent()
        }
      }
      if (item.contentType === 'terminal') {
        // closeTerminalTab runs its own pin guard + post-confirm force-reenter; arm on actual close.
        closeTerminalTab(item.entityId, { onClosed: armIfEmptying })
        return
      }
      const state = useAppStore.getState()
      guardPinnedTabClose({
        isPinned: item.isPinned === true,
        tabLabel: resolvePinnedTabLabel(state, FLOATING_TERMINAL_WORKTREE_ID, visibleId),
        onClose: () => {
          const latest = useAppStore.getState()
          if (item.contentType === 'browser') {
            destroyWorkspaceWebviews(latest.browserPagesByWorkspace, item.entityId)
            closeBrowserTab(item.entityId)
          } else if (item.contentType === 'simulator') {
            closeUnifiedTab(item.id)
          } else {
            const file = latest.openFiles.find((candidate) => candidate.id === item.entityId)
            if (file?.isDirty) {
              pendingReclaimArmByFileIdRef.current.set(item.entityId, armIfEmptying)
              queueEditorCloseRequests([item.entityId])
              return
            }
            closeFile(item.entityId)
          }
          armIfEmptying()
        }
      })
    },
    [closeBrowserTab, closeFile, closeUnifiedTab, groupTabs, queueEditorCloseRequests]
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

  const closeToSide = useCallback(
    (visibleId: string, side: 'left' | 'right') => {
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
      const sideIds =
        side === 'right'
          ? currentGroup.tabOrder.slice(index + 1)
          : currentGroup.tabOrder.slice(0, index)
      const tabById = new Map(currentGroupTabs.map((tab) => [tab.id, tab]))
      closeFloatingItems(
        sideIds.filter((tabId) => {
          const tab = tabById.get(tabId)
          return tab ? !tab.isPinned : false
        })
      )
    },
    [activeGroup, closeFloatingItems]
  )

  const closeToRight = useCallback(
    (visibleId: string) => closeToSide(visibleId, 'right'),
    [closeToSide]
  )

  const closeToLeft = useCallback(
    (visibleId: string) => closeToSide(visibleId, 'left'),
    [closeToSide]
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

  const reportFloatingFocusFromTarget = useCallback((target: EventTarget | null): void => {
    reportFloatingFocus(target)
  }, [])

  // Run a deferred dirty-editor arm check once the save dialog resolved and the file left the panel.
  // Declared before the reclaim-consume effect below so the intent is armed in the same commit the
  // count reaches 0; a cancelled dialog drops the entry instead (see the cancel handler).
  useEffect(() => {
    const pending = pendingReclaimArmByFileIdRef.current
    if (pending.size === 0) {
      return
    }
    for (const [fileId, armIfEmptying] of pending) {
      if (!floatingFiles.some((file) => file.id === fileId)) {
        pending.delete(fileId)
        armIfEmptying()
      }
    }
  }, [floatingFiles])

  // Reclaim keyboard ownership when the panel empties — but only if a panel-owned emptying close armed
  // the one-shot intent. Decoupling reclaim from *which* layer closed (L2/L3 keyboard, close button, or
  // guest IPC) keeps the next Cmd/Ctrl+T targeting the floating panel, while a background or unfocused
  // close leaves the intent unset so it never steals focus from the main workspace.
  useEffect(() => {
    if (visibleFloatingItemCount > 0) {
      // A create that repopulated the panel makes any armed intent stale — drop it so a later,
      // unrelated emptying can't consume it and steal focus.
      clearFloatingPanelReclaimIntent()
      return
    }
    if (consumeFloatingPanelReclaimIntent()) {
      focusPanelForShortcutsAfterClose()
    }
  }, [focusPanelForShortcutsAfterClose, visibleFloatingItemCount])

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

  // Detach can't prune the registry (it would drop the entry the current render just wrote), so the
  // live tab list does it here instead.
  useEffect(() => {
    terminalPaneRegistry.retainOnly(tabs.map((tab) => tab.id))
  }, [tabs, terminalPaneRegistry])

  // Double-tap-bound close: invoke the active terminal pane's own split-aware close authority directly
  // (the same executeClosePane L3 runs). L3's window listener can't resolve a synthetic double-tap, so
  // deferring would strand it — this is the direct path. Falls back to a whole-item confirmed close
  // when no terminal handle is mounted (e.g. active tab is not a terminal).
  const closeActiveFloatingTerminalPane = useCallback(() => {
    const handle = activeTerminalId ? terminalPaneRegistry.getHandle(activeTerminalId) : null
    if (handle) {
      handle.closeActivePane()
      return
    }
    if (activeClosableTab) {
      closeFloatingItemConfirmed(activeClosableTab.id)
    }
  }, [activeClosableTab, activeTerminalId, closeFloatingItemConfirmed, terminalPaneRegistry])

  // One pass over every chord the panel claims. Its keydown preflight and its dispatch consume the
  // same resolution, so a single event is never re-scanned against the shortcut table.
  const resolveFloatingPanelShortcut = useCallback(
    (input: FloatingPanelShortcutInput): FloatingPanelShortcutResolution | null => {
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

      const ownedAction = matchFloatingWorkspacePanelOwnedAction(
        input,
        platform,
        state.keybindings,
        matchOptions
      )
      if (ownedAction !== null && ownedAction !== 'tab.close') {
        return { kind: 'create', action: ownedAction }
      }
      // A focused floating terminal defers its close chord to L3 (the split-pane/confirm authority);
      // a double-tap L3 can't observe closes the active pane here. Non-terminal closes the tab.
      const focusedFloatingTerminal =
        isFloatingTerminalInput && activeTab?.contentType === 'terminal'
      if (
        ownedAction === 'tab.close' ||
        (focusedFloatingTerminal &&
          isTerminalPaneCloseChord(input, platform, state.keybindings, matchOptions, matchOptions))
      ) {
        return { kind: 'close', focusedFloatingTerminal }
      }
      // Rename / indexed-switch / window max-min via the shared policy so dispatch, its preflight, and
      // App.tsx's gate stay single-sourced.
      const panelShortcut = matchFloatingWorkspacePanelShortcut(
        input,
        platform,
        state.keybindings,
        matchOptions,
        floatingChromeMatchOptions
      )
      if (panelShortcut === null) {
        return null
      }
      return panelShortcut.kind === 'index'
        ? { kind: 'index', index: panelShortcut.index }
        : { kind: 'chrome', action: panelShortcut.action }
    },
    [activeTab]
  )

  const applyFloatingPanelShortcut = useCallback(
    (
      resolution: FloatingPanelShortcutResolution,
      input: FloatingPanelShortcutInput,
      consume: () => void
    ): FloatingShortcutOutcome => {
      if (resolution.kind === 'create') {
        consume()
        if (resolution.action === 'tab.newTerminal') {
          createFloatingTerminalTab()
        } else if (resolution.action === 'tab.newBrowser') {
          createFloatingBrowserTab()
        } else if (resolution.action === 'tab.newMarkdown') {
          createFloatingMarkdownTab()
        } else {
          openFloatingMarkdownTab()
        }
        return 'handled'
      }
      if (resolution.kind === 'close') {
        if (resolution.focusedFloatingTerminal) {
          if (input.doubleTapModifier) {
            consume()
            closeActiveFloatingTerminalPane()
            return 'handled'
          }
          return 'deferred'
        }
        consume()
        if (activeClosableTab) {
          closeFloatingItemConfirmed(activeClosableTab.id)
        } else {
          onOpenChange(false)
        }
        return 'handled'
      }
      // Consume a matched index even out-of-range so it never leaks.
      if (resolution.kind === 'index') {
        consume()
        const visibleId = visibleFloatingTabOrder[resolution.index]
        if (visibleId) {
          activateFloatingItem(visibleId)
        }
        return 'handled'
      }
      if (resolution.action === 'tab.rename') {
        if (!activeTab) {
          return 'unmatched'
        }
        consume()
        useAppStore.getState().setRenamingTabId(activeTab.id)
        return 'handled'
      }
      consume()
      if (resolution.action === 'floatingWorkspace.maximize') {
        toggleMaximized()
      } else {
        onOpenChange(false)
      }
      return 'handled'
    },
    [
      activeClosableTab,
      activeTab,
      activateFloatingItem,
      closeActiveFloatingTerminalPane,
      closeFloatingItemConfirmed,
      createFloatingBrowserTab,
      createFloatingMarkdownTab,
      createFloatingTerminalTab,
      onOpenChange,
      openFloatingMarkdownTab,
      toggleMaximized,
      visibleFloatingTabOrder
    ]
  )

  const handleFloatingPanelShortcutAction = useCallback(
    (input: FloatingPanelShortcutInput, consume: () => void): FloatingShortcutOutcome => {
      const resolution = resolveFloatingPanelShortcut(input)
      return resolution === null
        ? 'unmatched'
        : applyFloatingPanelShortcut(resolution, input, consume)
    },
    [applyFloatingPanelShortcut, resolveFloatingPanelShortcut]
  )

  // Live closures for the window-capture and guest-bridge listeners. Reading them through a ref pins
  // those subscriptions to [open] instead of tearing down and re-adding on every tab reorder,
  // active-tab change, or close-helper identity change.
  const floatingShortcutListenersRef = useRef({
    activateFloatingItem,
    closeFloatingItemConfirmed,
    handleFloatingPanelShortcutAction,
    visibleFloatingTabOrder
  })
  useEffect(() => {
    floatingShortcutListenersRef.current = {
      activateFloatingItem,
      closeFloatingItemConfirmed,
      handleFloatingPanelShortcutAction,
      visibleFloatingTabOrder
    }
  }, [
    activateFloatingItem,
    closeFloatingItemConfirmed,
    handleFloatingPanelShortcutAction,
    visibleFloatingTabOrder
  ])

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

      // The target check above already enforces the panel's shortcut-surface gate, so the shared
      // resolution is the whole preflight — no second scan of the match table.
      const nativeEvent = event.nativeEvent
      const resolution = resolveFloatingPanelShortcut(nativeEvent)
      if (resolution === null) {
        return
      }

      applyFloatingPanelShortcut(resolution, nativeEvent, () => event.preventDefault())
    },
    [applyFloatingPanelShortcut, open, resolveFloatingPanelShortcut]
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
      // Match L1's yield and Terminal.tsx's guard: own the chord if the event target is inside the
      // panel even while activeElement is mid-transition, so an L1-yielded chord is never dropped.
      if (!isEventTargetInsideFloatingWorkspacePanel(event.target) && !isPanelFocused()) {
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

      const dispatchShortcut =
        floatingShortcutListenersRef.current.handleFloatingPanelShortcutAction
      // Both 'handled' and 'deferred' stop L2's own directional dispatch; only 'deferred' leaves the
      // event un-consumed so the terminal pane's L3 handler runs.
      if (
        detected &&
        dispatchShortcut(
          { doubleTapModifier: detected.modifier, target: event.target },
          consume
        ) !== 'unmatched'
      ) {
        return
      }

      if (dispatchShortcut(event, consume) !== 'unmatched') {
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
  }, [open])

  // A focused floating *browser* guest's close/index chords arrive over IPC (useIpcEvents)
  // as these window events; handle them through the exact same closures the keyboard path uses so
  // pin guard, reclaim intent, and index selection stay single-sourced.
  useEffect(() => {
    if (!open || typeof window === 'undefined') {
      return
    }
    const handleGuestClose = (event: Event): void => {
      const detail = (event as CustomEvent<FloatingWorkspaceGuestCloseDetail>).detail
      if (detail) {
        floatingShortcutListenersRef.current.closeFloatingItemConfirmed(detail.sourceId, {
          guestOwned: true
        })
      }
    }
    const handleGuestSelectIndex = (event: Event): void => {
      const detail = (event as CustomEvent<FloatingWorkspaceGuestSelectIndexDetail>).detail
      const listeners = floatingShortcutListenersRef.current
      const visibleId = detail ? listeners.visibleFloatingTabOrder[detail.index] : undefined
      if (visibleId) {
        listeners.activateFloatingItem(visibleId)
      }
    }
    window.addEventListener(FLOATING_WORKSPACE_GUEST_CLOSE_EVENT, handleGuestClose)
    window.addEventListener(FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT, handleGuestSelectIndex)
    return () => {
      window.removeEventListener(FLOATING_WORKSPACE_GUEST_CLOSE_EVENT, handleGuestClose)
      window.removeEventListener(
        FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT,
        handleGuestSelectIndex
      )
    }
  }, [open])

  useEffect(() => {
    const pendingReclaimArms = pendingReclaimArmByFileIdRef.current
    if (!open) {
      reportFloatingFocus(null, true)
      // Drop a stale emptying-close reclaim intent on panel close: if a concurrent tab-create kept
      // the panel from reaching 0, the count→0 consume never fired and the sticky intent must not
      // survive to a later empty-panel mount and steal focus (F3 leak, defense-in-depth). Deferred
      // dirty-editor arms are dropped for the same reason.
      clearFloatingPanelReclaimIntent()
      pendingReclaimArms.clear()
    }
    return () => {
      reportFloatingFocus(null, true)
      clearFloatingPanelReclaimIntent()
      pendingReclaimArms.clear()
    }
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
      reportFloatingFocus(null, true)
      // Cancel any pending emptying-close reclaim: an outside pointer-down is a genuine ownership release.
      clearFloatingPanelReclaimIntent()
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
        return
      }
      // Why: browser webviews focus out-of-process and do not emit renderer
      // pointerdown events, so release floating ownership on renderer blur too.
      reportFloatingFocus(null, true)
      // Window blur to another app is a genuine ownership release; drop any pending emptying-close reclaim.
      clearFloatingPanelReclaimIntent()
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
      const reclaim = reclaimTerminalInputOnWindowFocusRef.current
      if (!reclaim) {
        return
      }
      reclaimTerminalInputOnWindowFocusRef.current = null
      const panel = panelRef.current
      const active = document.activeElement
      if (
        panel &&
        active instanceof HTMLElement &&
        panel.contains(active) &&
        isFloatingWorkspaceTerminalInputTarget(active)
      ) {
        reportFloatingFocus(active)
        return
      }
      if ((active === null || active === document.body) && activeTerminalId) {
        if (reclaim.helper.isConnected && panel?.contains(reclaim.helper)) {
          // Why: TerminalPane owns exact-helper reclaim and IME refresh. Avoid
          // racing it with a second floating-layer blur/refocus cycle.
          return
        }
        // Why: only a helper that genuinely remounted while backgrounded needs
        // tab/leaf recovery; the shared TerminalPane owner cannot reclaim it.
        focusTerminalTabSurface(activeTerminalId, reclaim.leafId, {
          onlyIfFocusUnclaimed: true,
          onImeRefocusSkipped: (active) => reportFloatingFocus(active),
          refreshImeContext: true
        })
      }
    }

    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
    return () => {
      reclaimTerminalInputOnWindowFocusRef.current = null
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [activeTerminalId, open])
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
      onFocusCapture={(event) => reportFloatingFocusFromTarget(event.target)}
      onBlurCapture={(event) => {
        // Why: keep terminal-first shortcut ownership latched during the
        // synchronous macOS IME refresh blur; refocus or its skip callback settles it.
        if (!isTerminalImeInputContextRefreshing(event.target)) {
          reportFloatingFocusFromTarget(event.relatedTarget)
        }
      }}
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
              onClose={closeFloatingItemConfirmed}
              onCloseOthers={closeOthers}
              onCloseToRight={closeToRight}
              onCloseToLeft={closeToLeft}
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
              onCloseFile={closeFloatingItemConfirmed}
              onActivateBrowserTab={activateFloatingItem}
              onCloseBrowserTab={closeFloatingItemConfirmed}
              onDuplicateBrowserTab={(browserTabId) => {
                const source = browserTabs.find((tab) => tab.id === browserTabId)
                if (!source) {
                  return
                }
                createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, source.url, {
                  ...buildDuplicatedBrowserTabOptions(source),
                  targetGroupId: activeGroup?.id,
                  browserRuntimeEnvironmentId: null
                })
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
            ? tabs
                .filter((tab) => !parkedTerminalTabIds.has(tab.id))
                .map((tab) => {
                  const isActive = tab.id === activeTerminalId
                  return (
                    <div
                      key={`${tab.id}-${tab.generation ?? 0}`}
                      className={isActive ? 'absolute inset-0' : 'absolute inset-0 hidden'}
                      aria-hidden={!isActive}
                    >
                      <TerminalPane
                        ref={terminalPaneRegistry.getRefCallback(tab.id)}
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
                        onPtyExit={(ptyId) => {
                          if (shouldDeferParkedPtyExitTabClose(tab.id, ptyId)) {
                            return
                          }
                          closeTerminalTab(tab.id, {
                            reason: 'pty-exit',
                            lifecyclePtyId: ptyId
                          })
                        }}
                        onCloseTab={() => closeFloatingItemConfirmed(tab.id)}
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
                <FloatingBrowserSlot browserTab={tab} isActive={open && isActive} />
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
