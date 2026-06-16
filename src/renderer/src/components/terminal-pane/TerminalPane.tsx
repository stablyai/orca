/* eslint-disable max-lines -- Why: terminal pane component co-locates title state, layout serialization, and portal rendering to keep pane lifecycle consistent. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { IDisposable } from '@xterm/xterm'
import { X } from 'lucide-react'
import { useAppStore } from '../../store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog'
import { DaemonActionDialog, useDaemonActions } from '@/components/shared/useDaemonActions'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  isTerminalBackgroundLight,
  normalizeColor,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import TerminalSearch from '@/components/TerminalSearch'
import type { PtyTransport } from './pty-transport'
import { fitPanes, isWindowsUserAgent, shellEscapePath } from './pane-helpers'
import { getConnectionId } from '@/lib/connection-context'
import { resolveTerminalDropTargetShell } from './terminal-drop-handler'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { EMPTY_LAYOUT, serializeTerminalLayout } from './layout-serialization'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  applyExpandedLayoutTo,
  cancelPendingPaneSizeRefreshFrames,
  createExpandCollapseActions,
  restoreExpandedLayoutFrom
} from './expand-collapse'
import { useTerminalKeyboardShortcuts, type SearchState } from './keyboard-handlers'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { useTerminalFontZoom } from './useTerminalFontZoom'
import CloseTerminalDialog from './CloseTerminalDialog'
import { MobileDriverOverlay } from './MobileDriverOverlay'
import { TerminalErrorToast } from './TerminalErrorToast'
import { TerminalSessionStateSaveFailureDialog } from './TerminalSessionStateSaveFailureDialog'
import TerminalContextMenu from './TerminalContextMenu'
import { TerminalAgentSessionForkDialog } from './TerminalAgentSessionForkDialog'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { useTerminalPaneLifecycle } from './use-terminal-pane-lifecycle'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import { useNotificationDispatch } from './use-notification-dispatch'
import { connectPanePty } from './pty-connection'
import { shouldPreserveTerminalScrollbackBuffers } from '../../../../shared/workspace-session-terminal-buffers'
import {
  getAllOverrides,
  getFitOverrideForPty,
  onOverrideChange
} from '@/lib/pane-manager/mobile-fit-overrides'
import {
  getAllDrivers,
  getDriverForPty,
  isPtyLocked,
  onDriverChange
} from '@/lib/pane-manager/mobile-driver-state'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { captureTerminalShutdownLayout } from './terminal-shutdown-layout-capture'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { closeWebRuntimeTerminal } from '@/runtime/web-runtime-session'
import { isPrimarySelectionEnabled, readPrimarySelectionText } from '@/lib/primary-selection'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { isTerminalSessionStateSaveFailure } from '../../../../shared/terminal-session-state-save-failure'
import {
  isSyntheticSinglePaneTitle,
  sanitizeTerminalLayoutPaneTitles
} from '@/lib/terminal-pane-title-sanitization'
import { planTerminalLiveLayoutInsertions } from './terminal-live-layout-reconciliation'
import type { TerminalQuickCommand, TerminalQuickCommandScope } from '../../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete,
  terminalQuickCommandMatchesRepo
} from '../../../../shared/terminal-quick-commands'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import { scheduleImagePasteWebglAtlasRecovery } from './terminal-webgl-paste-recovery'
import { restoreTerminalFitToDesktop, restoreTerminalFitsToDesktop } from './terminal-fit-restore'

// Why: registry lives in a leaf module so the store slice can import it
// without re-entering the `slice → TerminalPane → store → slice` cycle
// that otherwise leaves createTerminalSlice undefined at store-init time.
import { shutdownBufferCaptures } from './shutdown-buffer-captures'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'
import { pasteTerminalText } from './terminal-bracketed-paste'
import {
  applyTerminalPaneAttentionToManager,
  subscribeTerminalPaneAttention
} from './terminal-pane-attention-subscriptions'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import { getCachedTerminalGroupIdForWorktree } from './terminal-unified-tab-lookup'
import { useRepoById } from '@/store/selectors'
import { translate } from '@/i18n/i18n'

type TerminalPaneProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible?: boolean
  // Why: when set (Activity portal), this pane visually isolates the given
  // split pane so only that leaf is shown. Implemented as a transient layout
  // override (separate snapshot ref) — does NOT touch expandedPaneId state
  // or persist to the layout snapshot, so returning to the workspace shows
  // the original split layout unchanged.
  isolatedPaneKey?: string | null
  onPtyExit: (ptyId: string) => void
  onCloseTab: () => void
}

type TerminalQuickCommandEditorDialogProps = {
  command: TerminalQuickCommand
  onOpenChange: (open: boolean) => void
  onSave: (command: TerminalQuickCommand) => void
}

function TerminalQuickCommandEditorDialog({
  command,
  onOpenChange,
  onSave
}: TerminalQuickCommandEditorDialogProps): React.JSX.Element {
  const repos = useAppStore((store) => store.repos)

  return (
    <TerminalQuickCommandDialog
      open
      mode="add"
      command={command}
      repos={repos}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

function formatClipboardImagePasteError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Image paste failed: ${detail}`
}

function isXtermHelperTextarea(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
}

export default function TerminalPane({
  tabId,
  worktreeId,
  cwd,
  isActive,
  isVisible = true,
  isolatedPaneKey = null,
  onPtyExit,
  onCloseTab
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const managerRef = useRef<PaneManager | null>(null)
  const paneFontSizesRef = useRef<Map<number, number>>(new Map())
  const expandedPaneIdRef = useRef<number | null>(null)
  const expandedStyleSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const pendingPaneSizeRefreshFrameIdsRef = useRef<number[]>([])
  // Why (separate from expandedStyleSnapshotRef): Activity isolation is a
  // transient view override that must not collide with the user-facing
  // expanded-pane state or the layout snapshot. Keeping its own snapshot
  // map means applyExpandedLayoutTo's internal restore (which targets the
  // ref it was passed) only clears Activity's overlay, not the user's.
  const activityIsolationSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const paneTransportsRef = useRef<Map<number, PtyTransport>>(new Map())
  // Why: per-pane live cwd tracked via OSC 7 for split-pane cwd inheritance.
  // See docs/ssh-split-pane-inherit-cwd.md. The OSC 7 handler is installed
  // in use-terminal-pane-lifecycle; keyboard and context-menu split actions
  // read this map at dispatch time to pass cwd into splitPane.
  const paneCwdRef = useRef<Map<number, { cwd: string; confirmed: boolean }>>(new Map())
  const paneMode2031Ref = useRef<Map<number, boolean>>(new Map())
  const paneLastThemeModeRef = useRef<Map<number, 'dark' | 'light'>>(new Map())
  const panePtyBindingsRef = useRef<Map<number, IDisposable>>(new Map())
  // Why: tracks panes currently replaying recorded PTY bytes into xterm
  // (cold-restore, daemon snapshot, scrollback restore, eager-buffer flush).
  // While non-zero, pty-connection.ts drops xterm onData so auto-replies to
  // embedded query sequences don't leak to the shell. See replay-guard.ts.
  const replayingPanesRef = useRef<Map<number, number>>(new Map())
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const isVisibleRef = useRef(isVisible)
  isVisibleRef.current = isVisible

  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  // Why: tracked in React state (not derived from managerRef.getPanes().length)
  // so the render containing the portal map (which reads the imperative pane
  // list via managerRef.current?.getPanes()) re-runs when a pane is split or
  // closed. managerRef is imperative and doesn't trigger React's dependency
  // tracking. The lifecycle hook updates this via setPaneCount on
  // onPaneCreated / onPaneClosed / onLayoutChanged. The value is never
  // read — the portal map at line ~914 calls `managerRef.current?.getPanes()`
  // imperatively, so `setPaneCount` is used only as a render-trigger side
  // effect to force that map to re-run when a pane is split or closed.
  const [paneCount, setPaneCount] = useState<number>(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  const searchStateRef = useRef<SearchState>({ query: '', caseSensitive: false, regex: false })
  const [closeConfirmPaneId, setCloseConfirmPaneId] = useState<number | null>(null)
  const [quickCommandEditorOpen, setQuickCommandEditorOpen] = useState(false)
  // Why: the terminal menu can be the first quick-command entry point, so each
  // Add action starts with a fresh draft instead of reusing cancelled text.
  const [quickCommandDraft, setQuickCommandDraft] = useState(createTerminalQuickCommandDraft)
  const [agentSessionFork, setAgentSessionFork] = useState<PreparedAgentSessionFork | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [sessionStateSaveFailureOpen, setSessionStateSaveFailureOpen] = useState(false)
  const daemonActions = useDaemonActions()
  // Why: override state lives in a plain Map for perf (safeFit reads it on
  // every resize). This counter forces a re-render when overrides change so
  // the mobile-fit banner appears/disappears. When an override is cleared
  // (desktop-fit), we also trigger safeFit on affected panes so the terminal
  // resizes back to desktop dimensions.
  const [, setOverrideTick] = useState(0)
  useEffect(() => {
    const pendingFitFrames = new Set<number>()
    const pendingFallbackTimers = new Set<number>()

    const scheduleFitFrame = (callback: () => void): void => {
      const frameId = window.requestAnimationFrame(() => {
        pendingFitFrames.delete(frameId)
        callback()
      })
      pendingFitFrames.add(frameId)
    }

    const scheduleFallbackTimer = (callback: () => void): void => {
      const timerId = window.setTimeout(() => {
        pendingFallbackTimers.delete(timerId)
        callback()
      }, 100)
      pendingFallbackTimers.add(timerId)
    }

    const unsubscribe = onOverrideChange((event) => {
      setOverrideTick((n) => n + 1)
      if (event.mode === 'desktop-fit') {
        const manager = managerRef.current
        if (!manager) {
          return
        }
        // Why: pane IDs are per-tab, so resolve the affected PTY through this
        // tab's live transport bindings instead of global numeric pane IDs.
        const getAffectedPanes = (): ReturnType<typeof manager.getPanes> =>
          manager
            .getPanes()
            .filter((pane) => paneTransportsRef.current.get(pane.id)?.getPtyId() === event.ptyId)
        // Why: fitAddon.fit() measures DOM dimensions, so it must run after
        // the browser has settled layout. Running synchronously inside the
        // IPC callback can produce stale measurements. rAF ensures the DOM
        // is ready. The follow-up timeout acts as a safety net: if
        // fitAddon.fit() silently threw (its errors are caught), the timeout
        // falls back to a direct terminal.resize() using the restored
        // dimensions from the runtime. This guarantees xterm exits mobile
        // dims even when the DOM-based fit path fails.
        const fitAffectedPanes = (): void => {
          for (const pane of getAffectedPanes()) {
            safeFit(pane)
          }
        }
        scheduleFitFrame(fitAffectedPanes)
        // Why: belt-and-suspenders — if safeFit's fitAddon.fit() threw or
        // was a no-op due to stale dimensions, fall back to a direct
        // resize. ONLY fire if xterm is still parked at the prior
        // mobile-fit dims, meaning safeFit failed to move it. Previously
        // we also fired when xterm had moved to *any* size other than
        // the captured baseline, which clobbered safeFit's correct
        // DOM-measured fit when the desktop pane geometry had changed
        // since mobile-fit started (e.g. user closed a split or resized
        // the window while the phone was active). In that scenario the
        // event.cols/rows is the stale baseline from the moment
        // mobile-fit started, not the current pane geometry — applying
        // it would shrink the terminal back to e.g. half-width.
        scheduleFallbackTimer(() => {
          for (const pane of getAffectedPanes()) {
            // Why: skip the fallback for hidden/unmounted panes whose
            // container is 0×0. Force-resizing xterm to the server's
            // desktop dims while the DOM has no geometry leaves xterm
            // with cols/rows that won't match when the tab is later
            // activated (the activation refit will correct it). The
            // fallback is for the *visible* pane that legitimately
            // failed to refit via the rAF safeFit.
            const rect = pane.container.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) {
              continue
            }
            safeFit(pane)
            const stuckAtMobile =
              event.priorCols != null &&
              event.priorRows != null &&
              pane.terminal.cols === event.priorCols &&
              pane.terminal.rows === event.priorRows
            if (stuckAtMobile && event.cols > 0 && event.rows > 0) {
              pane.terminal.resize(event.cols, event.rows)
            }
          }
        })
      }
    })

    return () => {
      unsubscribe()
      for (const frameId of pendingFitFrames) {
        window.cancelAnimationFrame(frameId)
      }
      pendingFitFrames.clear()
      for (const timerId of pendingFallbackTimers) {
        window.clearTimeout(timerId)
      }
      pendingFallbackTimers.clear()
    }
  }, [])

  // Why: presence-lock banner re-render. Driver state lives in a plain Map
  // for perf; this counter forces a re-render when the driver flips so the
  // lock banner appears/disappears. See docs/mobile-presence-lock.md.
  const [, setDriverTick] = useState(0)
  useEffect(
    () =>
      onDriverChange(() => {
        setDriverTick((n) => n + 1)
      }),
    []
  )

  // Pane title state — keyed by ephemeral paneId, persisted via titlesByLeafId
  // in the layout snapshot. Ref keeps persistLayoutSnapshot closures fresh.
  const [paneTitles, setPaneTitles] = useState<Record<number, string>>({})
  const paneTitlesRef = useRef<Record<number, string>>({})
  paneTitlesRef.current = paneTitles
  const removedTitleLeafIdsRef = useRef<Set<string>>(new Set())
  const clearedScrollbackLeafIdsRef = useRef<Set<string>>(new Set())
  const [renamingPaneId, setRenamingPaneId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  // Guard against double-submit: when the user presses Enter, handleRenameSubmit
  // runs and then the input unmounts causing onBlur to fire handleRenameSubmit
  // again. Similarly, pressing Escape runs handleRenameCancel but blur would
  // then call handleRenameSubmit, saving the title the user wanted to discard.
  const renameSubmittedRef = useRef(false)
  const renameSessionIdRef = useRef(0)
  const renameBlurCommitEnabledRef = useRef(true)
  const renameFocusFrameRef = useRef<number | null>(null)
  const renameEnableBlurFrameRef = useRef<number | null>(null)
  const renameRefocusFrameRef = useRef<number | null>(null)
  const onPtyErrorRef = useRef((_paneId: number, message: string) => {
    if (isTerminalSessionStateSaveFailure(message)) {
      setTerminalError(null)
      setSessionStateSaveFailureOpen(true)
      return
    }
    setTerminalError((prev) => (prev ? `${prev}\n${message}` : message))
  })

  const setTabPaneExpanded = useAppStore((store) => store.setTabPaneExpanded)
  const setTabCanExpandPane = useAppStore((store) => store.setTabCanExpandPane)
  const suppressPtyExit = useAppStore((store) => store.suppressPtyExit)
  const pendingCodexPaneRestartIds = useAppStore((store) => store.pendingCodexPaneRestartIds)
  const consumePendingCodexPaneRestart = useAppStore(
    (store) => store.consumePendingCodexPaneRestart
  )
  const clearCodexRestartNotice = useAppStore((store) => store.clearCodexRestartNotice)
  const savedLayout = useAppStore((store) => store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const terminalTab = useAppStore((store) =>
    getCachedTerminalTabForWorktree(store.tabsByWorktree, worktreeId, tabId)
  )
  const setTabLayout = useAppStore((store) => store.setTabLayout)
  const restoredLayout = useMemo(
    () => (terminalTab ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab) : savedLayout),
    [savedLayout, terminalTab]
  )
  const initialLayoutRef = useRef(restoredLayout)
  const updateTabTitle = useAppStore((store) => store.updateTabTitle)
  const setRuntimePaneTitle = useAppStore((store) => store.setRuntimePaneTitle)
  const clearRuntimePaneTitle = useAppStore((store) => store.clearRuntimePaneTitle)
  const updateTabPtyId = useAppStore((store) => store.updateTabPtyId)
  const clearTabPtyId = useAppStore((store) => store.clearTabPtyId)
  const markWorktreeUnread = useAppStore((store) => store.markWorktreeUnread)
  const markTerminalTabUnread = useAppStore((store) => store.markTerminalTabUnread)
  const markTerminalPaneUnread = useAppStore((store) => store.markTerminalPaneUnread)
  const clearWorktreeUnread = useAppStore((store) => store.clearWorktreeUnread)
  const clearTerminalTabUnread = useAppStore((store) => store.clearTerminalTabUnread)
  const clearTerminalPaneUnread = useAppStore((store) => store.clearTerminalPaneUnread)
  const openSpacePage = useAppStore((store) => store.openSpacePage)
  const refreshWorkspaceSpace = useAppStore((store) => store.refreshWorkspaceSpace)
  const settings = useAppStore((store) => store.settings)
  const updateSettings = useAppStore((store) => store.updateSettings)
  const requestLinkRoutingPreference = useLinkRoutingPreferenceDialog()
  const keybindings = useAppStore((store) => store.keybindings)
  // Why: Windows is the only platform where bare right-click is repurposed as
  // a paste gesture; on macOS/Linux the terminal still owns right-click for the
  // context menu. The settings default keeps the Windows shortcut feeling native
  // without changing the other platforms' interaction model.
  const rightClickToPaste = isWindowsUserAgent() && (settings?.terminalRightClickToPaste ?? true)
  // Why: Windows ConPTY does not forward DECSET 2004 from foreground TUIs, so
  // xterm may not know multi-line text needs bracketed-paste protection.
  const forceBracketedMultilineTextPaste = isWindowsUserAgent()
  const [startup] = useState(() => useAppStore.getState().pendingStartupByTabId[tabId])
  const shouldMeasureHiddenStartup = startup !== undefined && !isVisible
  const consumeTabStartupCommand = useAppStore((store) => store.consumeTabStartupCommand)
  const [setupSplit] = useState(() => useAppStore.getState().pendingSetupSplitByTabId[tabId])
  const consumeTabSetupSplit = useAppStore((store) => store.consumeTabSetupSplit)
  const [issueCommandSplit] = useState(
    () => useAppStore.getState().pendingIssueCommandSplitByTabId[tabId]
  )
  const consumeTabIssueCommandSplit = useAppStore((store) => store.consumeTabIssueCommandSplit)
  useEffect(() => {
    if (startup) {
      consumeTabStartupCommand(tabId)
    }
  }, [startup, tabId, consumeTabStartupCommand])

  const openDiskSpaceAnalyzer = useCallback(() => {
    setSessionStateSaveFailureOpen(false)
    openSpacePage()
    void refreshWorkspaceSpace().catch((err: unknown) => {
      console.warn('Failed to refresh Space Analyzer after terminal session save failure:', err)
    })
  }, [openSpacePage, refreshWorkspaceSpace])

  const quickCommandRepoId =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? null : getRepoIdFromWorktreeId(worktreeId)
  const quickCommandRepo = useRepoById(quickCommandRepoId)
  const quickCommandRepoLabel = quickCommandRepo
    ? quickCommandRepo.displayName || quickCommandRepo.path
    : quickCommandRepoId
      ? 'This Repo'
      : null
  const validQuickCommands = (settings?.terminalQuickCommands ?? []).filter((command) =>
    isTerminalQuickCommandComplete(command)
  )
  const repoQuickCommands = validQuickCommands.filter((command) => {
    const scope = getTerminalQuickCommandScope(command)
    return scope.type === 'repo' && terminalQuickCommandMatchesRepo(command, quickCommandRepoId)
  })
  const globalQuickCommands = validQuickCommands.filter(
    (command) => getTerminalQuickCommandScope(command).type === 'global'
  )
  const quickCommandGroupId =
    useAppStore(
      (s) =>
        getCachedTerminalGroupIdForWorktree(s.unifiedTabsByWorktree, worktreeId, tabId) ??
        s.activeGroupIdByWorktree[worktreeId] ??
        null
    ) ?? null

  const openQuickCommandEditor = useCallback((scope: TerminalQuickCommandScope): void => {
    setQuickCommandDraft(createTerminalQuickCommandDraft(scope))
    setQuickCommandEditorOpen(true)
  }, [])

  const saveQuickCommand = useCallback(
    (command: TerminalQuickCommand): void => {
      const currentCommands = useAppStore.getState().settings?.terminalQuickCommands ?? []
      void updateSettings({ terminalQuickCommands: [...currentCommands, command] })
    },
    [updateSettings]
  )

  useEffect(() => {
    if (setupSplit) {
      consumeTabSetupSplit(tabId)
    }
  }, [setupSplit, tabId, consumeTabSetupSplit])

  // Clear the queued issue-command split once this tab has captured it for initial mount.
  useEffect(() => {
    if (issueCommandSplit) {
      consumeTabIssueCommandSplit(tabId)
    }
  }, [issueCommandSplit, tabId, consumeTabIssueCommandSplit])

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const openLinksInAppPreferencePromiseRef = useRef<Promise<boolean> | null>(null)

  const requestOpenLinksInAppPreference = useCallback(
    (url: string): Promise<boolean> | null => {
      if (settingsRef.current?.openLinksInAppPreferencePrompted === true) {
        return null
      }
      if (!settingsRef.current) {
        return null
      }
      if (openLinksInAppPreferencePromiseRef.current) {
        return openLinksInAppPreferencePromiseRef.current
      }
      const preferencePromise = (async () => {
        const openInOrca = await requestLinkRoutingPreference({
          openLinksInAppDefault: settingsRef.current?.openLinksInApp === true,
          url
        })
        await updateSettings({
          openLinksInApp: openInOrca,
          openLinksInAppPreferencePrompted: true
        })
        return openInOrca
      })()
      openLinksInAppPreferencePromiseRef.current = preferencePromise
      void preferencePromise.finally(() => {
        openLinksInAppPreferencePromiseRef.current = null
      })
      return preferencePromise
    },
    [requestLinkRoutingPreference, updateSettings]
  )
  // Why: the persisted setting can be 'auto' (default) or one of the four
  // explicit modes. useEffectiveMacOptionAsAlt resolves 'auto' into
  // 'true' | 'false' based on the probe's current layout category (US → 'true',
  // anything else → 'false'), and re-renders when the OS layout changes.
  // Downstream keyboard handlers read the ref, so the ref also tracks the
  // effective value, not the raw setting.
  const effectiveMacOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  const macOptionAsAltRef = useRef<MacOptionAsAlt>(effectiveMacOptionAsAlt)
  macOptionAsAltRef.current = effectiveMacOptionAsAlt
  const onPtyExitRef = useRef(onPtyExit)
  onPtyExitRef.current = onPtyExit

  const systemPrefersDark = useSystemPrefersDark()
  const dispatchNotification = useNotificationDispatch(worktreeId)
  const setCacheTimerStartedAt = useAppStore((store) => store.setCacheTimerStartedAt)

  // Memoized with useCallback so downstream hooks (useTerminalKeyboardShortcuts,
  // useTerminalPaneLifecycle, createExpandCollapseActions) don't tear down and
  // re-register event listeners on every render. All data it reads comes from
  // refs (managerRef, containerRef, expandedPaneIdRef, paneTitlesRef) or
  // stable values (tabId, setTabLayout), so the dependency array is minimal.
  const persistLayoutSnapshot = useCallback((): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      return
    }
    const activePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const leafIdByPaneId = manager.getLeafIdMap()
    const layout = serializeTerminalLayout(
      container,
      activePaneId,
      expandedPaneIdRef.current,
      leafIdByPaneId
    )
    const existing = useAppStore.getState().terminalLayoutsByTabId[tabId]
    const currentPanes = manager.getPanes()
    const currentLeafIds = new Set(currentPanes.map((p) => p.leafId))
    const clearedScrollbackLeafIds = clearedScrollbackLeafIdsRef.current
    const scrollbackPreserveLeafIds = new Set(
      [...currentLeafIds].filter((leafId) => !clearedScrollbackLeafIds.has(leafId))
    )
    // Preserve existing buffersByLeafId so layout-only persists (resize, split,
    // reorder) don't clobber previously captured scrollback. Drop entries for
    // leaves that no longer exist.
    const mergedBuffers = mergeCapturedLeafState({
      prior: existing?.buffersByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedBuffers).length > 0) {
      layout.buffersByLeafId = mergedBuffers
    }
    const mergedScrollbackRefs = mergeCapturedLeafState({
      prior: existing?.scrollbackRefsByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedScrollbackRefs).length > 0) {
      layout.scrollbackRefsByLeafId = mergedScrollbackRefs
    }
    // Why: between pane creation and the deferred rAF where PTYs actually
    // attach, all transports have getPtyId() === null. The merge below
    // preserves the *prior* snapshot's leaf→PTY mappings while still letting
    // any live transports overwrite them. Without preservation, a rapid
    // successive remount (tab moved again before the first rAF) would lose
    // the mappings and force fresh PTY spawns.
    const livePtyEntries = currentPanes
      .map((p) => [p.leafId, paneTransportsRef.current.get(p.id)?.getPtyId() ?? null] as const)
      .filter(
        (entry): entry is readonly [(typeof currentPanes)[number]['leafId'], string] =>
          entry[1] !== null
      )
    const mergedPtyIds = mergeCapturedLeafState({
      prior: existing?.ptyIdsByLeafId,
      fresh: Object.fromEntries(livePtyEntries),
      currentLeafIds
    })
    if (Object.keys(mergedPtyIds).length > 0) {
      layout.ptyIdsByLeafId = mergedPtyIds
    }
    // Preserve pane titles — uses the live React state (via ref) rather than
    // the stale Zustand value because React state reflects in-flight title
    // edits that haven't been persisted yet.
    const titlesByLeafId: Record<string, string> = {}
    const removedTitleLeafIds = removedTitleLeafIdsRef.current
    for (const pane of currentPanes) {
      const existingTitle = existing?.titlesByLeafId?.[pane.leafId]
      if (existingTitle && !removedTitleLeafIds.has(pane.leafId)) {
        titlesByLeafId[pane.leafId] = existingTitle
      }
    }
    // Why: active agents can trigger layout persists while pane-title React
    // state is catching up. Preserve existing leaf titles unless this pane
    // explicitly removed them, then overlay the live local pane-title state.
    const titles = paneTitlesRef.current
    for (const pane of currentPanes) {
      const title = titles[pane.id]
      if (title) {
        titlesByLeafId[pane.leafId] = title
        removedTitleLeafIds.delete(pane.leafId)
      }
    }
    if (Object.keys(titlesByLeafId).length > 0) {
      layout.titlesByLeafId = titlesByLeafId
    }
    setTabLayout(tabId, layout)
    for (const leafId of currentLeafIds) {
      clearedScrollbackLeafIds.delete(leafId)
    }
  }, [tabId, setTabLayout])

  const clearPaneScrollback = useCallback(
    (pane: ManagedPane): void => {
      clearedScrollbackLeafIdsRef.current.add(pane.leafId)
      pane.terminal.clear()
      persistLayoutSnapshot()
    },
    [persistLayoutSnapshot]
  )

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const sanitized = sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab)
    if (sanitized !== savedLayout) {
      setTabLayout(tabId, sanitized)
    }
  }, [savedLayout, setTabLayout, tabId, terminalTab])

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    if (panes.length !== 1) {
      return
    }
    const paneId = panes[0].id
    const currentTitle = paneTitlesRef.current[paneId]
    if (!currentTitle || !isSyntheticSinglePaneTitle(currentTitle, terminalTab)) {
      return
    }
    const nextTitles = { ...paneTitlesRef.current }
    delete nextTitles[paneId]
    paneTitlesRef.current = nextTitles
    setPaneTitles((prev) => {
      if (!prev[paneId] || !isSyntheticSinglePaneTitle(prev[paneId], terminalTab)) {
        return prev
      }
      const next = { ...prev }
      delete next[paneId]
      return next
    })
    persistLayoutSnapshot()
  }, [paneCount, paneTitles, persistLayoutSnapshot, terminalTab])

  const syncPanePtyLayoutBinding = useCallback(
    (paneId: number, ptyId: string | null): void => {
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
      const { ptyIdsByLeafId: _existingPtyIdsByLeafId, ...layoutWithoutPtyBindings } =
        existingLayout
      const existingBindings = existingLayout.ptyIdsByLeafId ?? {}
      const leafId = managerRef.current?.getLeafId(paneId)
      if (!leafId) {
        return
      }

      if (ptyId) {
        setTabLayout(tabId, {
          ...layoutWithoutPtyBindings,
          // Why: PTY ownership changes happen after the synchronous layout
          // snapshot on mount. Persist the live pane→PTY binding here so
          // remounts attach each pane to its current shell instead of a stale
          // or missing PTY id from an earlier snapshot.
          ptyIdsByLeafId: {
            ...existingBindings,
            [leafId]: ptyId
          }
        })
        return
      }

      const nextBindings = { ...existingBindings }
      delete nextBindings[leafId]
      setTabLayout(tabId, {
        ...layoutWithoutPtyBindings,
        ...(Object.keys(nextBindings).length > 0 ? { ptyIdsByLeafId: nextBindings } : {})
      })
    },
    [setTabLayout, tabId]
  )

  const {
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    syncExpandedLayout,
    toggleExpandPane
  } = createExpandCollapseActions({
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    containerRef,
    managerRef,
    pendingPaneSizeRefreshFrameIdsRef,
    setExpandedPaneId,
    setTabPaneExpanded,
    tabId,
    persistLayoutSnapshot
  })

  const executeClosePane = useCallback(
    (paneId: number) => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      if (manager.getPanes().length <= 1) {
        onCloseTab()
      } else {
        // Why: clear the cache timer for this specific pane before closing it,
        // so the sidebar doesn't show a stale countdown for a pane that no
        // longer exists. The closeTab path handles bulk cleanup, but closing
        // a single split pane doesn't go through closeTab.
        const ptyId = paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
        closeWebRuntimeTerminal(ptyId)
        const leafId = manager.getLeafId(paneId)
        if (leafId) {
          useAppStore.getState().setCacheTimerStartedAt(makePaneKey(tabId, leafId), null)
          useAppStore.getState().dropAgentStatus(makePaneKey(tabId, leafId))
        }
        syncPanePtyLayoutBinding(paneId, null)
        manager.closePane(paneId)
      }
    },
    [onCloseTab, syncPanePtyLayoutBinding, tabId]
  )

  // Cmd+W handler — shows a confirmation dialog when the pane's shell has
  // a running child process (e.g. npm run dev), so the user doesn't
  // accidentally kill it. An idle shell prompt closes immediately. Ctrl+D
  // (explicit EOF) bypasses this by design.
  const handleRequestClosePane = useCallback(
    (paneId: number) => {
      const transport = paneTransportsRef.current.get(paneId)
      const ptyId = transport?.getPtyId()
      if (!ptyId) {
        executeClosePane(paneId)
        return
      }
      const settings = useAppStore.getState().settings
      void inspectRuntimeTerminalProcess(settings, ptyId)
        .then((process) => {
          if (process.hasChildProcesses) {
            setCloseConfirmPaneId(paneId)
          } else {
            executeClosePane(paneId)
          }
        })
        // Why: if the child-process probe rejects (IPC wedged, handler
        // missing on legacy providers), fall back to closing the pane — Cmd+W
        // silently doing nothing is worse than closing a pane that might have
        // had a child process. Matches the semantics of the !ptyId branch above.
        .catch(() => executeClosePane(paneId))
    },
    [executeClosePane]
  )

  const handleSearchSelectedText = useCallback((selectedText: string): void => {
    const state = useAppStore.getState()
    state.showRightSidebarSearch({ query: selectedText })
  }, [])

  const handleConfirmClose = useCallback(() => {
    if (closeConfirmPaneId === null) {
      return
    }
    executeClosePane(closeConfirmPaneId)
    setCloseConfirmPaneId(null)
  }, [closeConfirmPaneId, executeClosePane])

  useTerminalPaneLifecycle({
    tabId,
    worktreeId,
    cwd,
    startup,
    setupSplit,
    issueCommandSplit,
    isActive,
    isVisible,
    systemPrefersDark,
    settings,
    settingsRef,
    requestOpenLinksInAppPreference,
    effectiveMacOptionAsAlt,
    effectiveMacOptionAsAltRef: macOptionAsAltRef,
    initialLayoutRef,
    managerRef,
    containerRef,
    expandedStyleSnapshotRef,
    paneFontSizesRef,
    paneTransportsRef,
    paneCwdRef,
    paneMode2031Ref,
    paneLastThemeModeRef,
    panePtyBindingsRef,
    replayingPanesRef,
    isActiveRef,
    isVisibleRef,
    onPtyExitRef,
    onPtyErrorRef,
    clearTabPtyId,
    consumeSuppressedPtyExit: useAppStore((store) => store.consumeSuppressedPtyExit),
    updateTabTitle,
    setRuntimePaneTitle,
    clearRuntimePaneTitle,
    updateTabPtyId,
    markWorktreeUnread,
    markTerminalTabUnread,
    markTerminalPaneUnread,
    clearWorktreeUnread,
    clearTerminalTabUnread,
    clearTerminalPaneUnread,
    dispatchNotification,
    setCacheTimerStartedAt,
    syncPanePtyLayoutBinding,
    setTabPaneExpanded,
    setTabCanExpandPane,
    setExpandedPane,
    syncExpandedLayout,
    persistLayoutSnapshot,
    setPaneTitles,
    paneTitlesRef,
    setRenamingPaneId,
    setPaneCount
  })

  useEffect(() => {
    if (!(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) {
      return
    }
    const manager = managerRef.current
    if (!manager || !restoredLayout.root) {
      return
    }
    const insertions = planTerminalLiveLayoutInsertions(
      restoredLayout.root,
      manager.getPanes().map((pane) => pane.leafId)
    )
    if (insertions.length === 0) {
      return
    }

    let appliedInsertion = false
    for (const insertion of insertions) {
      const ptyId = restoredLayout.ptyIdsByLeafId?.[insertion.newLeafId]
      const sourcePaneId = manager.getNumericIdForLeaf(insertion.sourceLeafId)
      if (!ptyId || sourcePaneId === null || manager.getNumericIdForLeaf(insertion.newLeafId)) {
        continue
      }
      // Why: paired web terminals receive host split-pane snapshots after the
      // pane manager is already mounted. Adopt the host leaf + PTY instead of
      // spawning a local-only web pane.
      // Before-placement swaps [source, new] after splitPane, so invert the
      // host first-child ratio before applying it to the temporary order.
      const splitRatio =
        insertion.ratio === undefined
          ? undefined
          : insertion.placement === 'before'
            ? 1 - insertion.ratio
            : insertion.ratio
      const createdPane = manager.splitPaneAroundLeafIds(
        insertion.sourceLeafIds,
        sourcePaneId,
        insertion.direction,
        {
          ...(splitRatio !== undefined && { ratio: splitRatio }),
          leafId: insertion.newLeafId,
          ptyId,
          placement: insertion.placement
        }
      )
      if (!createdPane) {
        continue
      }
      appliedInsertion = true
    }

    if (appliedInsertion) {
      persistLayoutSnapshot()
    }

    if (restoredLayout.activeLeafId) {
      const activePaneId = manager.getNumericIdForLeaf(restoredLayout.activeLeafId)
      if (activePaneId !== null) {
        manager.setActivePane(activePaneId, { focus: isActive })
      }
    }
  }, [isActive, paneCount, persistLayoutSnapshot, restoredLayout])

  // Why (Activity-only pane isolation): when this TerminalPane is being
  // portaled into the Activity page for a specific agent pane, hide the
  // other split siblings so the user only sees that agent's pane. Uses
  // applyExpandedLayoutTo with a separate snapshot ref so the override is
  // independent of the user-facing expanded-pane state and the persisted
  // layout snapshot — closing Activity restores the original split layout.
  // useLayoutEffect: layout style writes must land before paint to avoid
  // a flash of all panes. paneCount is in deps so the effect re-applies
  // after splits/closes change the manager's pane list.
  useLayoutEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    // Why: refit on rAF so xterm measures the post-layout DOM, not the
    // pre-toggle one. Mirrors expand-collapse.refreshPaneSizes. Both the
    // apply and restore paths must refit — restoring without a fit leaves
    // xterm sized for the isolated single-pane geometry, so the workspace
    // view (or staging slot) renders at the wrong cols/rows until some
    // unrelated event triggers another fit.
    const scheduleRefit = (): number =>
      requestAnimationFrame(() => {
        const manager = managerRef.current
        if (!manager) {
          return
        }
        for (const pane of manager.getPanes()) {
          safeFit(pane)
        }
      })
    if (isolatedPaneKey === null) {
      restoreExpandedLayoutFrom(snapshots)
      const frame = scheduleRefit()
      return () => {
        cancelAnimationFrame(frame)
      }
    }
    const manager = managerRef.current
    const resolution = resolvePaneKeyForManager(tabId, isolatedPaneKey, manager)
    const resolvedPaneId = resolution.status === 'resolved' ? resolution.numericPaneId : null
    const applied =
      resolvedPaneId !== null &&
      ((manager?.getPanes().length ?? 0) <= 1 ||
        applyExpandedLayoutTo(resolvedPaneId, {
          managerRef,
          containerRef,
          expandedStyleSnapshotRef: activityIsolationSnapshotRef
        }))
    if (!applied) {
      restoreExpandedLayoutFrom(snapshots)
      const root = containerRef.current?.firstElementChild
      if (root instanceof HTMLElement) {
        // Why: Activity requested an exact pane. If it cannot be resolved, fail
        // closed instead of showing the whole split terminal as a fallback.
        snapshots.set(root, { display: root.style.display, flex: root.style.flex })
        root.style.display = 'none'
      }
      const frame = scheduleRefit()
      return () => {
        cancelAnimationFrame(frame)
      }
    }
    const frame = scheduleRefit()
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [isolatedPaneKey, paneCount, tabId])

  // Why: belt-and-suspenders unmount cleanup. If the component unmounts
  // while isolation is active (e.g. tab closed mid-Activity-view), restore
  // sibling display/flex so the captured DOM doesn't leak inline styles.
  useEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    return () => {
      restoreExpandedLayoutFrom(snapshots)
      cancelPendingPaneSizeRefreshFrames({ pendingPaneSizeRefreshFrameIdsRef })
    }
  }, [])

  const handleRestartCodexPane = useCallback(
    (paneId: number) => {
      const manager = managerRef.current
      const pane = manager?.getPanes().find((candidate) => candidate.id === paneId)
      if (!manager || !pane) {
        return
      }

      const transport = paneTransportsRef.current.get(paneId)
      const panePtyBinding = panePtyBindingsRef.current.get(paneId)
      const existingPtyId = transport?.getPtyId()

      if (existingPtyId) {
        suppressPtyExit(existingPtyId)
        clearCodexRestartNotice(existingPtyId)
        // Why: pane-scoped Codex restarts should preserve the split layout and
        // replace only the stale session in place. Clearing the PTY binding and
        // consuming the upcoming suppressed exit keeps the pane mounted while a
        // fresh PTY reconnects under the newly selected Codex account.
        clearTabPtyId(tabId, existingPtyId)
      }

      panePtyBinding?.dispose()
      panePtyBindingsRef.current.delete(paneId)
      syncPanePtyLayoutBinding(paneId, null)
      transport?.destroy?.()
      paneTransportsRef.current.delete(paneId)
      setCacheTimerStartedAt(makePaneKey(tabId, pane.leafId), null)
      setTerminalError(null)

      const newPaneBinding = connectPanePty(pane, manager, {
        tabId,
        worktreeId,
        cwd,
        startup: { command: 'codex' },
        paneTransportsRef,
        paneMode2031Ref,
        paneLastThemeModeRef,
        replayingPanesRef,
        isActiveRef,
        isVisibleRef,
        onPtyExitRef,
        onPtyErrorRef,
        clearTabPtyId,
        consumeSuppressedPtyExit: useAppStore.getState().consumeSuppressedPtyExit,
        updateTabTitle,
        setRuntimePaneTitle,
        clearRuntimePaneTitle,
        updateTabPtyId,
        markWorktreeUnread,
        markTerminalTabUnread,
        markTerminalPaneUnread,
        clearWorktreeUnread,
        clearTerminalTabUnread,
        clearTerminalPaneUnread,
        dispatchNotification,
        setCacheTimerStartedAt,
        syncPanePtyLayoutBinding
      })
      panePtyBindingsRef.current.set(paneId, newPaneBinding)
      manager.setActivePane(paneId, { focus: true })
    },
    [
      clearCodexRestartNotice,
      clearRuntimePaneTitle,
      clearTabPtyId,
      cwd,
      dispatchNotification,
      markWorktreeUnread,
      markTerminalTabUnread,
      markTerminalPaneUnread,
      clearWorktreeUnread,
      clearTerminalTabUnread,
      clearTerminalPaneUnread,
      onPtyExitRef,
      setCacheTimerStartedAt,
      setRuntimePaneTitle,
      suppressPtyExit,
      syncPanePtyLayoutBinding,
      tabId,
      updateTabPtyId,
      updateTabTitle,
      worktreeId
    ]
  )

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }

    for (const pane of manager.getPanes()) {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (!ptyId || !pendingCodexPaneRestartIds[ptyId]) {
        continue
      }
      // Why: the status-bar switcher can request a global restart for stale
      // Codex sessions, but the actual execution must stay pane scoped so a
      // split tab does not lose unrelated non-Codex panes.
      if (consumePendingCodexPaneRestart(ptyId)) {
        handleRestartCodexPane(pane.id)
      }
    }
  }, [consumePendingCodexPaneRestart, handleRestartCodexPane, pendingCodexPaneRestartIds])

  useTerminalFontZoom({ isActive, managerRef, paneFontSizesRef, settingsRef })

  useTerminalKeyboardShortcuts({
    tabId,
    isActive,
    keyboardScopeRef: containerRef,
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    fallbackCwd: cwd ?? '',
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onSearchSelectedText: handleSearchSelectedText,
    onRequestClosePane: handleRequestClosePane,
    onClearPaneScrollback: clearPaneScrollback,
    searchOpenRef,
    searchStateRef,
    macOptionAsAltRef,
    keybindings,
    terminalShortcutPolicy: settings?.terminalShortcutPolicy ?? 'orca-first'
  })

  useTerminalPaneGlobalEffects({
    tabId,
    // Why: use the pane's own `worktreeId` prop (not global activeWorktreeId)
    // so the terminal-drop resolver routes to the worktree that actually owns
    // this PTY. Reading from global state would race during worktree switches
    // — the drop listener is already gated by `isActive`, and the pane's own
    // id is the authoritative identity of the terminal being written to.
    worktreeId,
    cwd,
    isActive,
    isVisible,
    // Why: hidden startup probes are opacity-hidden but measurable; ordinary
    // hidden tabs are display:none and refit on visibility resume instead.
    isSyncFitEnabled: isVisible || shouldMeasureHiddenStartup,
    paneCount,
    managerRef,
    containerRef,
    paneTransportsRef,
    isActiveRef,
    isVisibleRef,
    toggleExpandPane
  })

  useEffect(() => {
    if (
      !(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ ||
      !isVisible ||
      !isActive
    ) {
      return
    }

    const cleanupCallbacks: (() => void)[] = []
    const fitAndForward = (): void => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      for (const pane of manager.getPanes()) {
        safeFit(pane)
        const transport = paneTransportsRef.current.get(pane.id)
        if (!transport?.isConnected()) {
          continue
        }
        const ptyId = transport.getPtyId()
        if (!ptyId) {
          continue
        }
        // Why: match pty-connection resize guards so web refit retries do not
        // forward SIGWINCH while mobile-lock or phone-fit overrides are active.
        if (getFitOverrideForPty(ptyId) || isPtyLocked(ptyId)) {
          continue
        }
        // Why: skip forwarding a stale near-zero fit to the host PTY while the
        // overlay is still settling after a worktree switch.
        if (pane.terminal.cols < 8 || pane.terminal.rows < 4) {
          continue
        }
        transport.resize(pane.terminal.cols, pane.terminal.rows)
      }
    }
    const scheduleFrame = (): void => {
      const frameId = requestAnimationFrame(fitAndForward)
      cleanupCallbacks.push(() => cancelAnimationFrame(frameId))
    }
    const scheduleTimer = (delayMs: number): void => {
      const timerId = window.setTimeout(fitAndForward, delayMs)
      cleanupCallbacks.push(() => window.clearTimeout(timerId))
    }

    // Why: web-restored terminals can fit before the remote PTY transport is
    // ready, then become xterm no-ops. Forward the settled cols explicitly.
    scheduleFrame()
    scheduleTimer(50)
    scheduleTimer(150)
    scheduleTimer(400)
    scheduleTimer(900)

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup()
      }
    }
  }, [isActive, isVisible])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const syncFocused = (focused: boolean): void => {
      window.api.ui.setTerminalInputFocused?.(focused)
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (isXtermHelperTextarea(event.target)) {
        syncFocused(true)
      }
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (!isXtermHelperTextarea(event.target)) {
        return
      }
      if (isXtermHelperTextarea(event.relatedTarget)) {
        return
      }
      syncFocused(false)
    }

    if (
      isXtermHelperTextarea(document.activeElement) &&
      container.contains(document.activeElement)
    ) {
      syncFocused(true)
    }
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)
    return () => {
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      if (
        isXtermHelperTextarea(document.activeElement) &&
        container.contains(document.activeElement)
      ) {
        syncFocused(false)
      }
    }
  }, [])

  // Intercept paste at the keydown level (configurable terminal paste chords)
  // AND as a fallback
  // on the paste event. We must handle keydown because Chromium does not fire
  // a paste event when the clipboard contains only image data (no text
  // representation) and the target is a textarea — which is exactly how
  // xterm.js receives focus. Without the keydown handler, image-only pastes
  // are silently discarded and tools like Claude Code never receive the image.
  //
  // The paste event handler is kept as a fallback for non-keyboard paste
  // triggers (Edit > Paste menu, programmatic paste, etc.) and also bypasses
  // Chromium's native clipboard pipeline that can cause concurrent clipboard
  // reads by CLI tools (e.g. Codex checking for images) to fail intermittently.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }

    const pasteFromClipboard = (pane: ManagedPane): void => {
      const connectionId = getConnectionId(worktreeId) ?? null
      void pasteTerminalClipboard({
        readClipboardText: window.api.ui.readClipboardText,
        saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
        connectionId,
        forceBracketedMultilineTextPaste,
        pasteText: (text, options) => {
          pasteTerminalText(pane.terminal, text, options)
          if (text) {
            recordTerminalUserInputForLeaf(tabId, pane.leafId)
          }
          if (options?.recoverImagePasteWebglAtlas) {
            scheduleImagePasteWebglAtlasRecovery()
          }
        },
        onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
      }).catch(() => {
        /* ignore clipboard failures */
      })
    }

    const isMac = navigator.userAgent.includes('Mac')
    const shortcutPlatform: NodeJS.Platform = isMac
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'
    let suppressNextNativePaste = false
    let pasteSuppressionTimerId: number | null = null
    const shouldSuppressNativePaste = (e: KeyboardEvent): boolean => {
      const key = e.key.toLowerCase()
      return (
        (isMac && key === 'v' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) ||
        (!isMac && key === 'v' && e.ctrlKey && !e.metaKey && !e.altKey) ||
        (!isMac && e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
      )
    }
    const onKeyPaste = (e: KeyboardEvent): void => {
      const target = e.target
      if (target instanceof Element && target.closest('[data-terminal-search-root]')) {
        return
      }
      const matchesPaste = keybindingMatchesAction(
        'terminal.paste',
        e,
        shortcutPlatform,
        keybindings,
        { context: 'terminal' }
      )
      if (!matchesPaste) {
        if (shouldSuppressNativePaste(e)) {
          // Why: bare Ctrl+V is readline's quote-insert on Windows/Linux. If
          // Chromium turns it into a native paste event, suppress that follow-up
          // paste while still letting xterm receive the original keydown.
          suppressNextNativePaste = true
          if (pasteSuppressionTimerId !== null) {
            window.clearTimeout(pasteSuppressionTimerId)
          }
          pasteSuppressionTimerId = window.setTimeout(() => {
            pasteSuppressionTimerId = null
            suppressNextNativePaste = false
          }, 0)
        }
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      pasteFromClipboard(pane)
    }

    // Fallback: handle paste events triggered by non-keyboard sources
    // (Edit > Paste menu, programmatic paste, etc.).
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target
      if (target instanceof Element && target.closest('[data-terminal-search-root]')) {
        return
      }
      if (suppressNextNativePaste) {
        suppressNextNativePaste = false
        if (pasteSuppressionTimerId !== null) {
          window.clearTimeout(pasteSuppressionTimerId)
          pasteSuppressionTimerId = null
        }
        e.preventDefault()
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      pasteFromClipboard(pane)
    }

    container.addEventListener('keydown', onKeyPaste, { capture: true })
    container.addEventListener('paste', onPaste, { capture: true })
    return () => {
      if (pasteSuppressionTimerId !== null) {
        window.clearTimeout(pasteSuppressionTimerId)
      }
      container.removeEventListener('keydown', onKeyPaste, { capture: true })
      container.removeEventListener('paste', onPaste, { capture: true })
    }
  }, [isActive, worktreeId, keybindings, forceBracketedMultilineTextPaste, tabId])

  // Why: a click inside the terminal container is a deliberate interaction
  // with the pane — dismiss the attention indicator for this tab and worktree
  // (ghostty "show until interact" semantics). onData already covers
  // keystrokes; pointerdown covers the mouse path, including right-click
  // and middle-click paste, which also count as engagement with the pane.
  //
  // This listener is intentionally NOT gated on `isActive`. In multi-group
  // split layouts (TabGroupPanel), several TerminalPane instances are
  // simultaneously visible but only ONE has `isActive=true` (the focused
  // group's active pane). When the user clicks into a visible-but-inactive
  // split pane, TabGroupPanel's wrapper `onPointerDown={commands.focusGroup}`
  // fires first; focusGroup clears tab-level unread but does NOT call
  // clearWorktreeUnread — so the worktree-level sidebar dot would linger
  // until another interaction. Attaching this listener unconditionally lets
  // the first click dismiss both dots BEFORE focusGroup re-renders the pane
  // as active and the effect deps change.
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      clearTerminalTabUnread(tabId)
      clearWorktreeUnread(worktreeId)
      const paneElement =
        event.target instanceof Element ? event.target.closest('.pane[data-leaf-id]') : null
      const leafId = paneElement?.getAttribute('data-leaf-id')
      if (leafId) {
        clearTerminalPaneUnread(makePaneKey(tabId, leafId))
      }
    }
    container.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }, [tabId, worktreeId, clearTerminalTabUnread, clearTerminalPaneUnread, clearWorktreeUnread])

  const applyTerminalPaneAttention = useCallback(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    applyTerminalPaneAttentionToManager(manager, tabId)
  }, [tabId])

  useLayoutEffect(() => {
    applyTerminalPaneAttention()
    return subscribeTerminalPaneAttention(tabId, applyTerminalPaneAttention)
  }, [tabId, paneCount, applyTerminalPaneAttention])

  // Sync the data-has-title attribute on pane containers when titles change,
  // and reflow terminals so safeFit() sees the correct available height.
  // useLayoutEffect (not useEffect) ensures the attribute and refit happen
  // synchronously after React commits but before the browser paints, so the
  // title bar offset is applied before the first visible frame and before
  // any pending requestAnimationFrame (e.g. queueResizeAll) measures dims.
  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    let needsFit = false
    for (const pane of manager.getPanes()) {
      // Show the title bar space when the pane has a title OR is being
      // inline-edited (so the input appears even for untitled panes).
      // Unread activity does NOT reserve title-bar space — the bell is
      // rendered as an absolutely-positioned overlay in the pane's top-right
      // corner so it can appear and disappear without shifting terminal
      // content, avoiding the jarring reflow on bell toggles.
      const shouldShow = !!paneTitles[pane.id] || renamingPaneId === pane.id
      const hadTitle = pane.container.hasAttribute('data-has-title')
      if (shouldShow && !hadTitle) {
        pane.container.setAttribute('data-has-title', '')
        needsFit = true
      } else if (!shouldShow && hadTitle) {
        pane.container.removeAttribute('data-has-title')
        needsFit = true
      }
    }
    if (needsFit) {
      fitPanes(manager)
    }
  }, [paneTitles, renamingPaneId])

  // Register a capture callback for shutdown. The beforeunload handler in
  // App.tsx calls all registered callbacks to serialize terminal buffers.
  useEffect(() => {
    const captureBuffers = (options?: { includeLocalBuffers?: boolean }): void => {
      const manager = managerRef.current
      const container = containerRef.current
      if (!manager || !container) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length === 0) {
        return
      }
      // Why: setTabLayout REPLACES — it doesn't merge. captureBuffers can
      // run during a transient window (post-remount, just-attached,
      // mid-replay) where xterm hasn't rendered yet so serialize returns 0
      // bytes. Without preservation, that empty pass would wipe a known-good
      // buffer. Merge prior state in for leaves whose live capture came back
      // empty. Same shape as persistLayoutSnapshot.
      const state = useAppStore.getState()
      const existing = state.terminalLayoutsByTabId[tabId]
      const includeLocalBuffers = options?.includeLocalBuffers ?? true
      const shouldCaptureScrollbackBuffers = includeLocalBuffers
        ? true
        : shouldPreserveTerminalScrollbackBuffers(worktreeId, state.repos)
      const layout = captureTerminalShutdownLayout({
        manager,
        container,
        expandedPaneId: expandedPaneIdRef.current,
        paneTransports: paneTransportsRef.current,
        paneTitlesByPaneId: paneTitlesRef.current,
        existingLayout: existing,
        // Why: beforeunload skips local/floating bytes because session payloads
        // immediately prune them; worktree sleep keeps them as defense-in-depth.
        captureBuffers: shouldCaptureScrollbackBuffers,
        clearedScrollbackLeafIds: clearedScrollbackLeafIdsRef.current
      })
      setTabLayout(tabId, layout)
      for (const pane of panes) {
        clearedScrollbackLeafIdsRef.current.delete(pane.leafId)
      }
    }
    shutdownBufferCaptures.set(tabId, captureBuffers)
    return () => {
      // Why: only remove if the entry still points at this closure. A
      // remount could have replaced it before the prior cleanup ran.
      if (shutdownBufferCaptures.get(tabId) === captureBuffers) {
        shutdownBufferCaptures.delete(tabId)
      }
    }
  }, [tabId, worktreeId, setTabLayout])

  const cancelPendingRenameFrames = useCallback(() => {
    const frameRefs = [renameFocusFrameRef, renameEnableBlurFrameRef, renameRefocusFrameRef]
    for (const frameRef of frameRefs) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  const closeRenameSession = useCallback(() => {
    renameSessionIdRef.current += 1
    renameBlurCommitEnabledRef.current = true
    cancelPendingRenameFrames()
  }, [cancelPendingRenameFrames])

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null): void => {
      containerRef.current = node
      if (node !== null) {
        return
      }
      // Why: inline title rename focus/blur frames are owned by the terminal
      // container; invalidate them when that DOM owner detaches.
      closeRenameSession()
    },
    [closeRenameSession]
  )

  const handleStartRename = useCallback(
    (paneId: number) => {
      cancelPendingRenameFrames()
      renameSessionIdRef.current += 1
      renameBlurCommitEnabledRef.current = false
      renameSubmittedRef.current = false
      setRenameValue(paneTitlesRef.current[paneId] ?? '')
      setRenamingPaneId(paneId)
    },
    [cancelPendingRenameFrames]
  )

  const removePaneTitle = useCallback(
    (paneId: number) => {
      setPaneTitles((prev) => {
        if (!(paneId in prev)) {
          return prev
        }
        const next = { ...prev }
        delete next[paneId]
        return next
      })
      // Eagerly remove from the ref so persistLayoutSnapshot sees the change.
      if (paneId in paneTitlesRef.current) {
        const next = { ...paneTitlesRef.current }
        delete next[paneId]
        paneTitlesRef.current = next
      }
      const leafId = managerRef.current?.getPanes().find((pane) => pane.id === paneId)?.leafId
      if (leafId) {
        removedTitleLeafIdsRef.current.add(leafId)
      }
      persistLayoutSnapshot()
    },
    [persistLayoutSnapshot]
  )

  const handleRenameSubmit = useCallback(() => {
    if (renamingPaneId === null || renameSubmittedRef.current) {
      return
    }
    renameSubmittedRef.current = true
    const trimmed = renameValue.trim()
    if (trimmed.length === 0) {
      if (paneTitlesRef.current[renamingPaneId]) {
        removePaneTitle(renamingPaneId)
      }
      closeRenameSession()
      setRenamingPaneId(null)
      return
    }
    setPaneTitles((prev) => ({ ...prev, [renamingPaneId]: trimmed }))
    // Eagerly update the ref so persistLayoutSnapshot (which reads
    // paneTitlesRef.current) sees the new title immediately, without
    // waiting for React to re-render and assign it during the next
    // render pass.
    paneTitlesRef.current = { ...paneTitlesRef.current, [renamingPaneId]: trimmed }
    const leafId = managerRef.current?.getPanes().find((pane) => pane.id === renamingPaneId)?.leafId
    if (leafId) {
      removedTitleLeafIdsRef.current.delete(leafId)
    }
    closeRenameSession()
    setRenamingPaneId(null)
    // Persist immediately so the title survives restarts.
    persistLayoutSnapshot()
  }, [closeRenameSession, renamingPaneId, renameValue, removePaneTitle, persistLayoutSnapshot])

  const handleRenameCancel = useCallback(() => {
    renameSubmittedRef.current = true
    closeRenameSession()
    setRenamingPaneId(null)
  }, [closeRenameSession])

  const handleRenameBlur = useCallback(() => {
    if (renameBlurCommitEnabledRef.current) {
      handleRenameSubmit()
      return
    }
    if (renamingPaneId === null || renameRefocusFrameRef.current !== null) {
      return
    }

    const sessionId = renameSessionIdRef.current
    const paneId = renamingPaneId
    // Why: the context-menu selection can be followed by a delayed Radix/xterm
    // focus handoff. That synthetic early blur is not a title submission.
    renameRefocusFrameRef.current = requestAnimationFrame(() => {
      renameRefocusFrameRef.current = null
      if (renameSessionIdRef.current !== sessionId || renamingPaneId !== paneId) {
        return
      }
      const input = renameInputRef.current
      if (!input) {
        renameBlurCommitEnabledRef.current = true
        handleRenameSubmit()
        return
      }
      input.focus()
      input.select()
      if (document.activeElement === input) {
        renameBlurCommitEnabledRef.current = true
        return
      }
      renameBlurCommitEnabledRef.current = true
      handleRenameSubmit()
    })
  }, [handleRenameSubmit, renamingPaneId])

  const handleRemoveTitle = useCallback(
    (paneId: number) => removePaneTitle(paneId),
    [removePaneTitle]
  )

  // Auto-focus and select-all in the rename input when the dialog opens.
  // Also reset the submit guard so the new rename session can accept input.
  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    const sessionId = renameSessionIdRef.current
    const paneId = renamingPaneId
    renameSubmittedRef.current = false
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      if (renameSessionIdRef.current !== sessionId || renamingPaneId !== paneId) {
        return
      }
      const input = renameInputRef.current
      if (!input) {
        return
      }
      input.focus()
      input.select()
      renameEnableBlurFrameRef.current = requestAnimationFrame(() => {
        renameEnableBlurFrameRef.current = null
        if (
          renameSessionIdRef.current === sessionId &&
          renamingPaneId === paneId &&
          renameInputRef.current === input &&
          document.activeElement === input
        ) {
          renameBlurCommitEnabledRef.current = true
        }
      })
    })
    return () => cancelPendingRenameFrames()
  }, [cancelPendingRenameFrames, renamingPaneId])

  const contextMenu = useTerminalPaneContextMenu({
    tabId,
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    worktreeId,
    groupId: quickCommandGroupId,
    fallbackCwd: cwd ?? '',
    toggleExpandPane,
    onRequestClosePane: handleRequestClosePane,
    onClearPaneScrollback: clearPaneScrollback,
    onSetTitle: handleStartRename,
    onPasteError: setTerminalError,
    onAgentSessionForkReady: setAgentSessionFork,
    forceBracketedMultilineTextPaste,
    rightClickToPaste
  })

  const getMobileOwnedTerminalPtyIds = useCallback((): string[] => {
    const ptyIds = new Set(getAllOverrides().keys())
    for (const [ptyId, driver] of getAllDrivers()) {
      if (driver.kind === 'mobile') {
        ptyIds.add(ptyId)
      }
    }
    return [...ptyIds]
  }, [])

  const restorePaneTerminalFit = useCallback(async (pane: ManagedPane): Promise<void> => {
    // Why: local and remote runtime PTYs use different transports, but the
    // desktop reclaim button should have one visible recovery behavior.
    const id = paneTransportsRef.current.get(pane.id)?.getPtyId()
    if (!id) {
      return
    }
    const restored = await restoreTerminalFitToDesktop(id, settingsRef.current ?? undefined)
    if (restored) {
      // Why: after the overlay unmounts, focus would otherwise stay on the
      // removed button/body instead of the terminal the user just reclaimed.
      pane.terminal.focus()
    }
  }, [])

  const restoreAllTerminalFits = useCallback(
    async (focusPane: ManagedPane): Promise<void> => {
      // Why: a mobile session can leave multiple PTYs held at phone size; bulk
      // restore follows the same reclaim path as the per-pane button.
      const restored = await restoreTerminalFitsToDesktop(
        getMobileOwnedTerminalPtyIds(),
        settingsRef.current ?? undefined
      )
      if (restored) {
        focusPane.terminal.focus()
      }
    },
    [getMobileOwnedTerminalPtyIds]
  )

  const terminalShouldHandleMiddleClick = useCallback(
    (target: EventTarget | null): target is Node => {
      if (!(target instanceof Element)) {
        return false
      }
      if (target.closest('[data-terminal-search-root]')) {
        return false
      }
      const editable = target.closest(
        'input, textarea, [contenteditable=""], [contenteditable="true"]'
      )
      return !editable || editable.classList.contains('xterm-helper-textarea')
    },
    []
  )

  const getPrimarySelectionMiddleClickPane = useCallback(
    (target: EventTarget | null) => {
      if (!terminalShouldHandleMiddleClick(target)) {
        return null
      }
      const manager = managerRef.current
      if (!manager) {
        return null
      }
      const clickedPane =
        manager.getPanes().find((pane) => pane.container.contains(target)) ??
        manager.getActivePane() ??
        manager.getPanes()[0]
      if (!clickedPane || clickedPane.terminal.modes.mouseTrackingMode !== 'none') {
        return null
      }
      return clickedPane
    },
    [terminalShouldHandleMiddleClick]
  )

  const handlePrimarySelectionMiddleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button !== 1 || !isPrimarySelectionEnabled()) {
        return
      }
      const clickedPane = getPrimarySelectionMiddleClickPane(event.target)
      if (!clickedPane) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clickedPane.terminal.focus()
      void readPrimarySelectionText().then((text) => {
        if (text) {
          pasteTerminalText(clickedPane.terminal, text)
          recordTerminalUserInputForLeaf(tabId, clickedPane.leafId)
        }
      })
    },
    [getPrimarySelectionMiddleClickPane, tabId]
  )

  const handlePrimarySelectionAuxClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (
        event.button === 1 &&
        isPrimarySelectionEnabled() &&
        getPrimarySelectionMiddleClickPane(event.target)
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    [getPrimarySelectionMiddleClickPane]
  )

  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null
  // Why: app light/dark mode can diverge from the selected terminal theme, so
  // pane-title contrast follows the effective terminal surface instead.
  const titleUsesLightSurface = isTerminalBackgroundLight(
    settings?.terminalColorOverrides?.background ?? effectiveAppearance?.theme?.background,
    {
      appSurface: effectiveAppearance?.mode,
      backgroundOpacity: settings?.terminalBackgroundOpacity
    }
  )

  const terminalContainerStyle: CSSProperties = {
    // Why: split groups can keep one terminal visible in an unfocused group so
    // users still see its output while typing elsewhere. Hiding on `isActive`
    // blanked the previously focused pane and exposed the white group body.
    display: isVisible || shouldMeasureHiddenStartup ? 'flex' : 'none',
    // Why: split divider lines intentionally overdraw inside the pane tree.
    // `hidden` reliably clips that pseudo-element paint at the terminal body.
    overflow: 'hidden',
    ...(shouldMeasureHiddenStartup ? { opacity: 0, pointerEvents: 'none' } : {}),
    ['--orca-terminal-divider-color' as string]:
      effectiveAppearance?.dividerColor ?? DEFAULT_TERMINAL_DIVIDER_DARK,
    ['--orca-terminal-divider-color-strong' as string]: normalizeColor(
      effectiveAppearance?.dividerColor,
      DEFAULT_TERMINAL_DIVIDER_DARK
    )
  }

  const activePane = managerRef.current?.getActivePane()
  return (
    <>
      <div
        ref={setContainerRef}
        className="absolute inset-0 min-h-0 min-w-0"
        data-native-file-drop-target="terminal"
        data-contextual-tour-target="terminal-pane-split-target"
        data-terminal-tab-id={tabId}
        data-pane-title-surface={titleUsesLightSurface ? 'light' : 'dark'}
        style={terminalContainerStyle}
        onContextMenuCapture={contextMenu.onContextMenuCapture}
        onMouseDownCapture={handlePrimarySelectionMiddleMouseDown}
        onAuxClickCapture={handlePrimarySelectionAuxClick}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => {
          const filePath = e.dataTransfer.getData(WORKSPACE_FILE_PATH_MIME)
          if (!filePath) {
            return
          }
          e.preventDefault()
          e.stopPropagation()
          const manager = managerRef.current
          if (!manager) {
            return
          }
          const pane = manager.getActivePane() ?? manager.getPanes()[0]
          if (!pane) {
            return
          }
          const transport = paneTransportsRef.current.get(pane.id)
          if (!transport) {
            return
          }
          const state = useAppStore.getState()
          const worktreePath =
            Object.values(state.worktreesByRepo ?? {})
              .flat()
              .find((worktree) => worktree.id === worktreeId)?.path ??
            cwd ??
            filePath
          const targetShell = resolveTerminalDropTargetShell({
            activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId,
            worktreePath,
            // Why: internal Explorer drags paste a worktree-absolute path
            // directly into the target shell. Runtime drops use the runtime
            // worktree's path shape; legacy SSH drops remain POSIX.
            connectionId: getConnectionId(worktreeId)
          })
          if (transport.sendInput(shellEscapePath(filePath, targetShell))) {
            recordTerminalUserInputForLeaf(tabId, pane.leafId)
          }
          // Move focus to the terminal so the user can keep typing where the
          // dropped path just landed. Without this, focus stays on the file
          // tree row that originated the drag and subsequent keystrokes do
          // not reach the pty — #978.
          pane.terminal.focus()
        }}
      />
      {terminalError && isActive && (
        <TerminalErrorToast
          error={terminalError}
          onDismiss={() => setTerminalError(null)}
          onRestartDaemon={() => daemonActions.setPending('restart')}
        />
      )}
      <DaemonActionDialog api={daemonActions} />
      {isActive && (
        <TerminalSessionStateSaveFailureDialog
          open={sessionStateSaveFailureOpen}
          onDismiss={() => setSessionStateSaveFailureOpen(false)}
          onOpenSpaceAnalyzer={openDiskSpaceAnalyzer}
        />
      )}
      {activePane?.container &&
        createPortal(
          <TerminalSearch
            isOpen={searchOpen}
            onClose={() => setSearchOpen(false)}
            searchAddon={activePane.searchAddon ?? null}
            searchStateRef={searchStateRef}
          />,
          activePane.container
        )}
      <TerminalContextMenu
        open={contextMenu.open}
        onOpenChange={contextMenu.setOpen}
        menuPoint={contextMenu.point}
        menuOpenedAtRef={contextMenu.menuOpenedAtRef}
        canClosePane={contextMenu.paneCount > 1}
        canExpandPane={contextMenu.paneCount > 1}
        canEqualizePaneSizes={contextMenu.paneCount > 1 && expandedPaneId === null}
        menuPaneIsExpanded={
          contextMenu.menuPaneId !== null && contextMenu.menuPaneId === expandedPaneId
        }
        onCopy={() => void contextMenu.onCopy()}
        onPaste={() => void contextMenu.onPaste()}
        onSplitRight={contextMenu.onSplitRight}
        onSplitDown={contextMenu.onSplitDown}
        keybindings={keybindings}
        onEqualizePaneSizes={contextMenu.onEqualizePaneSizes}
        onClosePane={contextMenu.onClosePane}
        onClearScreen={contextMenu.onClearScreen}
        onForkAgentSession={() => void contextMenu.onForkAgentSession()}
        repoQuickCommands={repoQuickCommands}
        globalQuickCommands={globalQuickCommands}
        quickCommandRepoLabel={quickCommandRepoLabel}
        onQuickCommand={contextMenu.onQuickCommand}
        onAddQuickCommand={
          quickCommandRepoId
            ? () => openQuickCommandEditor({ type: 'repo', repoId: quickCommandRepoId })
            : () => openQuickCommandEditor({ type: 'global' })
        }
        onToggleExpand={contextMenu.onToggleExpand}
        onSetTitle={contextMenu.onSetTitle}
        onCopyPaneId={contextMenu.onCopyPaneId}
      />
      {/* Why: repos is a broad store slice; only subscribe while the editor is visible. */}
      {quickCommandEditorOpen ? (
        <TerminalQuickCommandEditorDialog
          command={quickCommandDraft}
          onOpenChange={setQuickCommandEditorOpen}
          onSave={saveQuickCommand}
        />
      ) : null}
      <TerminalAgentSessionForkDialog
        open={agentSessionFork !== null}
        fork={agentSessionFork}
        onOpenChange={(open) => {
          if (!open) {
            setAgentSessionFork(null)
          }
        }}
      />
      {/* Title bar overlays — portaled into each pane container that has a title
          or is currently being renamed (so the inline input appears even for
          untitled panes when "Set Title..." is triggered).

          Note: managerRef is a React ref, so reading .getPanes() here does not
          by itself trigger re-renders when the pane list changes. This works
          because every operation that affects the pane list also updates React
          state — title operations update `paneTitles` or `renamingPaneId`,
          and structural changes (split, close) update those same signals via
          onPaneClosed / onPaneCreated callbacks — so React always re-renders
          this block when .getPanes() would return a different result. */}
      {(managerRef.current?.getPanes() ?? []).map((pane) => {
        const title = paneTitles[pane.id]
        const isEditing = renamingPaneId === pane.id
        if (!title && !isEditing) {
          return null
        }
        return createPortal(
          <div className="pane-title-bar" {...(isEditing ? { 'data-editing': '' } : {})}>
            {isEditing ? (
              <input
                ref={renameInputRef}
                className="pane-title-input"
                aria-label={translate(
                  'auto.components.terminal.pane.TerminalPane.7dbbfcbecc',
                  'Pane title'
                )}
                placeholder={translate(
                  'auto.components.terminal.pane.TerminalPane.7dbbfcbecc',
                  'Pane title'
                )}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleRenameSubmit()
                  } else if (e.key === 'Escape') {
                    handleRenameCancel()
                  }
                }}
                onBlur={handleRenameBlur}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="pane-title-text"
                  onClick={() => handleStartRename(pane.id)}
                  aria-label={translate(
                    'auto.components.terminal.pane.TerminalPane.cc5a2dc706',
                    'Edit pane title: {{value0}}',
                    { value0: title }
                  )}
                >
                  {title}
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="pane-title-close"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRemoveTitle(pane.id)
                      }}
                      aria-label={translate(
                        'auto.components.terminal.pane.TerminalPane.f984ab2a30',
                        'Remove pane title: {{value0}}',
                        { value0: title }
                      )}
                    >
                      <X className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    {translate(
                      'auto.components.terminal.pane.TerminalPane.ac112e9036',
                      'Remove title'
                    )}
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>,
          pane.container,
          `pane-title-${pane.id}`
        )
      })}
      {(managerRef.current?.getPanes() ?? []).map((pane) => {
        // Why: pane IDs can collide across tabs (e.g. tab 0 pane 1 and tab 1
        // pane 1). Using the transport's actual ptyId avoids showing banners
        // on the wrong pane when IDs overlap.
        const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
        if (!ptyId) {
          return null
        }
        // Why: two-state lock UI. (1) Driver is mobile → presence-lock,
        // input paused (docs/mobile-presence-lock.md). (2) No mobile driver
        // but a phone-fit override is still in place → indefinite hold
        // (docs/mobile-fit-hold.md). MobileDriverOverlay owns the visual
        // treatment and collapse-to-chip state; both branches share the
        // same local/remote desktop-restore route.
        const driver = getDriverForPty(ptyId)
        const isMobileDriving = driver.kind === 'mobile'
        const hasFitOverride = getFitOverrideForPty(ptyId) !== null
        if (!isMobileDriving && !hasFitOverride) {
          return null
        }
        return createPortal(
          <MobileDriverOverlay
            key={`mobile-driver-${pane.id}-${ptyId}`}
            driver={driver}
            hasFitOverride={hasFitOverride}
            rootClassName="mobile-driver-banner"
            onAction={() => restorePaneTerminalFit(pane)}
            onAllAction={() => restoreAllTerminalFits(pane)}
          />,
          pane.container,
          `mobile-driver-banner-${pane.id}`
        )
      })}
      <CloseTerminalDialog
        open={closeConfirmPaneId !== null}
        onCancel={() => setCloseConfirmPaneId(null)}
        onConfirm={handleConfirmClose}
      />
    </>
  )
}
