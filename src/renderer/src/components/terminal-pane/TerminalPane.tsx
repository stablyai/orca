/* eslint-disable max-lines -- Why: terminal pane component co-locates title state, layout serialization, and portal rendering to keep pane lifecycle consistent. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { IDisposable } from '@xterm/xterm'
import { useAppStore } from '../../store'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  normalizeColor,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import TerminalSearch from '@/components/TerminalSearch'
import type { PtyTransport } from './pty-transport'
import { fitPanes, isWindowsUserAgent, shellEscapePath } from './pane-helpers'
import { getConnectionId } from '@/lib/connection-context'
import { resolveTerminalDropTargetShell } from './terminal-drop-handler'
import { EMPTY_LAYOUT, serializeTerminalLayout } from './layout-serialization'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  applyExpandedLayoutTo,
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
import TerminalContextMenu from './TerminalContextMenu'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { useTerminalPaneLifecycle } from './use-terminal-pane-lifecycle'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import { useNotificationDispatch } from './use-notification-dispatch'
import { connectPanePty } from './pty-connection'
import { shouldPreserveTerminalScrollbackBuffers } from '../../../../shared/workspace-session-terminal-buffers'
import { getFitOverrideForPty, onOverrideChange } from '@/lib/pane-manager/mobile-fit-overrides'
import { getDriverForPty, onDriverChange } from '@/lib/pane-manager/mobile-driver-state'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { captureTerminalShutdownLayout } from './terminal-shutdown-layout-capture'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'

// Why: registry lives in a leaf module so the store slice can import it
// without re-entering the `slice → TerminalPane → store → slice` cycle
// that otherwise leaves createTerminalSlice undefined at store-init time.
import { shutdownBufferCaptures } from './shutdown-buffer-captures'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'

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
  const [terminalError, setTerminalError] = useState<string | null>(null)
  // Why: override state lives in a plain Map for perf (safeFit reads it on
  // every resize). This counter forces a re-render when overrides change so
  // the mobile-fit banner appears/disappears. When an override is cleared
  // (desktop-fit), we also trigger safeFit on affected panes so the terminal
  // resizes back to desktop dimensions.
  const [, setOverrideTick] = useState(0)
  useEffect(
    () =>
      onOverrideChange((event) => {
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
          requestAnimationFrame(fitAffectedPanes)
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
          setTimeout(() => {
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
          }, 100)
        }
      }),
    []
  )

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
  const [renamingPaneId, setRenamingPaneId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  // Guard against double-submit: when the user presses Enter, handleRenameSubmit
  // runs and then the input unmounts causing onBlur to fire handleRenameSubmit
  // again. Similarly, pressing Escape runs handleRenameCancel but blur would
  // then call handleRenameSubmit, saving the title the user wanted to discard.
  const renameSubmittedRef = useRef(false)
  const onPtyErrorRef = useRef((_paneId: number, message: string) => {
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
  const setTabLayout = useAppStore((store) => store.setTabLayout)
  const initialLayoutRef = useRef(savedLayout)
  const updateTabTitle = useAppStore((store) => store.updateTabTitle)
  const setRuntimePaneTitle = useAppStore((store) => store.setRuntimePaneTitle)
  const clearRuntimePaneTitle = useAppStore((store) => store.clearRuntimePaneTitle)
  const updateTabPtyId = useAppStore((store) => store.updateTabPtyId)
  const clearTabPtyId = useAppStore((store) => store.clearTabPtyId)
  const markWorktreeUnread = useAppStore((store) => store.markWorktreeUnread)
  const markTerminalTabUnread = useAppStore((store) => store.markTerminalTabUnread)
  const clearWorktreeUnread = useAppStore((store) => store.clearWorktreeUnread)
  const clearTerminalTabUnread = useAppStore((store) => store.clearTerminalTabUnread)
  const settings = useAppStore((store) => store.settings)
  // Why: Windows is the only platform where bare right-click is repurposed as
  // a paste gesture; on macOS/Linux the terminal still owns right-click for the
  // context menu. The settings default keeps the Windows shortcut feeling native
  // without changing the other platforms' interaction model.
  const rightClickToPaste = isWindowsUserAgent() && (settings?.terminalRightClickToPaste ?? true)
  const [startup] = useState(() => useAppStore.getState().pendingStartupByTabId[tabId])
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
    // Preserve existing buffersByLeafId so layout-only persists (resize, split,
    // reorder) don't clobber previously captured scrollback. Drop entries for
    // leaves that no longer exist.
    const mergedBuffers = mergeCapturedLeafState({
      prior: existing?.buffersByLeafId,
      fresh: {},
      currentLeafIds
    })
    if (Object.keys(mergedBuffers).length > 0) {
      layout.buffersByLeafId = mergedBuffers
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
    const titles = paneTitlesRef.current
    const titleEntries = currentPanes
      .filter((p) => titles[p.id])
      .map((p) => [p.leafId, titles[p.id]] as const)
    if (titleEntries.length > 0) {
      layout.titlesByLeafId = Object.fromEntries(titleEntries)
    }
    setTabLayout(tabId, layout)
  }, [tabId, setTabLayout])

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
    systemPrefersDark,
    settings,
    settingsRef,
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
    clearWorktreeUnread,
    clearTerminalTabUnread,
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
        clearWorktreeUnread,
        clearTerminalTabUnread,
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
      clearWorktreeUnread,
      clearTerminalTabUnread,
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
    onRequestClosePane: handleRequestClosePane,
    searchOpenRef,
    searchStateRef,
    macOptionAsAltRef
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
    managerRef,
    containerRef,
    paneTransportsRef,
    isActiveRef,
    isVisibleRef,
    toggleExpandPane
  })

  // Intercept paste at the keydown level (Cmd+V / Ctrl+V) AND as a fallback
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

    // Shared helper: try text first (fast path, single IPC call for the
    // common case), then check for a clipboard image only when text is empty
    // — which is the image-only clipboard scenario this fix targets.
    const pasteFromClipboard = (pane: { terminal: { paste: (data: string) => void } }): void => {
      void window.api.ui
        .readClipboardText()
        .then((text) => {
          if (text) {
            pane.terminal.paste(text)
            return
          }
          // Why: clipboard has no text — check for an image. This is the
          // image-only clipboard case (e.g. screenshot) where Chromium's paste
          // event would never fire on a textarea. We save the image to a temp
          // file and paste the path so the terminal process can access it.
          return window.api.ui.saveClipboardImageAsTempFile().then((filePath) => {
            if (filePath) {
              pane.terminal.paste(filePath)
            }
          })
        })
        .catch(() => {
          /* ignore clipboard failures */
        })
    }

    // Why: intercept Cmd+V / Ctrl+V at the keydown level so we can check
    // for clipboard images via Electron's main-process clipboard API. The
    // browser's paste event is unreliable for image-only clipboards when the
    // target is a <textarea> (xterm.js's hidden input), so this handler
    // ensures image paste works regardless.
    const isMac = navigator.userAgent.includes('Mac')
    const onKeyPaste = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'v') {
        return
      }
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey || e.shiftKey) {
        return
      }
      const target = e.target
      if (target instanceof Element && target.closest('[data-terminal-search-root]')) {
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
      container.removeEventListener('keydown', onKeyPaste, { capture: true })
      container.removeEventListener('paste', onPaste, { capture: true })
    }
  }, [isActive])

  // Why: a click inside the terminal container is a deliberate interaction
  // with the pane — dismiss the bell indicator for this tab and worktree
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
    const onPointerDown = (): void => {
      clearTerminalTabUnread(tabId)
      clearWorktreeUnread(worktreeId)
    }
    container.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }, [tabId, worktreeId, clearTerminalTabUnread, clearWorktreeUnread])

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
        captureBuffers: shouldCaptureScrollbackBuffers
      })
      setTabLayout(tabId, layout)
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

  const handleStartRename = useCallback((paneId: number) => {
    setRenameValue(paneTitlesRef.current[paneId] ?? '')
    setRenamingPaneId(paneId)
  }, [])

  const handleRenameSubmit = useCallback(() => {
    if (renamingPaneId === null || renameSubmittedRef.current) {
      return
    }
    renameSubmittedRef.current = true
    const trimmed = renameValue.trim()
    if (trimmed.length === 0) {
      // Empty input — just cancel, don't change anything.
      setRenamingPaneId(null)
      return
    }
    setPaneTitles((prev) => ({ ...prev, [renamingPaneId]: trimmed }))
    // Eagerly update the ref so persistLayoutSnapshot (which reads
    // paneTitlesRef.current) sees the new title immediately, without
    // waiting for React to re-render and assign it during the next
    // render pass.
    paneTitlesRef.current = { ...paneTitlesRef.current, [renamingPaneId]: trimmed }
    setRenamingPaneId(null)
    // Persist immediately so the title survives restarts.
    persistLayoutSnapshot()
  }, [renamingPaneId, renameValue, persistLayoutSnapshot])

  const handleRenameCancel = useCallback(() => {
    renameSubmittedRef.current = true
    setRenamingPaneId(null)
  }, [])

  const handleRemoveTitle = useCallback(
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
      persistLayoutSnapshot()
    },
    [persistLayoutSnapshot]
  )

  // Auto-focus and select-all in the rename input when the dialog opens.
  // Also reset the submit guard so the new rename session can accept input.
  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    renameSubmittedRef.current = false
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [renamingPaneId])

  const contextMenu = useTerminalPaneContextMenu({
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    fallbackCwd: cwd ?? '',
    toggleExpandPane,
    onRequestClosePane: handleRequestClosePane,
    onSetTitle: handleStartRename,
    rightClickToPaste
  })

  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null

  const terminalContainerStyle: CSSProperties = {
    // Why: split groups can keep one terminal visible in an unfocused group so
    // users still see its output while typing elsewhere. Hiding on `isActive`
    // blanked the previously focused pane and exposed the white group body.
    display: isVisible ? 'flex' : 'none',
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
        ref={containerRef}
        className="absolute inset-0 min-h-0 min-w-0"
        data-native-file-drop-target="terminal"
        data-terminal-tab-id={tabId}
        style={terminalContainerStyle}
        onContextMenuCapture={contextMenu.onContextMenuCapture}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/x-orca-file-path')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => {
          const filePath = e.dataTransfer.getData('text/x-orca-file-path')
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
          transport.sendInput(shellEscapePath(filePath, targetShell))
          // Move focus to the terminal so the user can keep typing where the
          // dropped path just landed. Without this, focus stays on the file
          // tree row that originated the drag and subsequent keystrokes do
          // not reach the pty — #978.
          pane.terminal.focus()
        }}
      />
      {terminalError && isActive && (
        <TerminalErrorToast error={terminalError} onDismiss={() => setTerminalError(null)} />
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
        onEqualizePaneSizes={contextMenu.onEqualizePaneSizes}
        onClosePane={contextMenu.onClosePane}
        onClearScreen={contextMenu.onClearScreen}
        quickCommands={(settings?.terminalQuickCommands ?? []).filter(
          (command) => command.label.trim() && command.command.trimEnd()
        )}
        onQuickCommand={contextMenu.onQuickCommand}
        onToggleExpand={contextMenu.onToggleExpand}
        onSetTitle={contextMenu.onSetTitle}
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
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleRenameSubmit()
                  } else if (e.key === 'Escape') {
                    handleRenameCancel()
                  }
                }}
                onBlur={handleRenameSubmit}
              />
            ) : (
              <>
                <span className="pane-title-text" onClick={() => handleStartRename(pane.id)}>
                  {title}
                </span>
                <button
                  className="pane-title-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRemoveTitle(pane.id)
                  }}
                  aria-label="Remove title"
                >
                  ×
                </button>
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
        // treatment and collapse-to-chip state; both branches share a
        // single IPC route through restoreTerminalFit.
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
            onAction={async () => {
              // Why: same restore intent has two transports. Remote-runtime PTYs
              // must call the environment RPC; local PTYs use the Electron IPC
              // handler. Both resolve active-mobile and held-no-subscriber states.
              const transport = paneTransportsRef.current.get(pane.id)
              const id = transport?.getPtyId()
              if (!id) {
                return
              }
              const remoteHandle = getRemoteRuntimeTerminalHandle(id)
              const environmentId =
                getRemoteRuntimePtyEnvironmentId(id) ??
                settingsRef.current?.activeRuntimeEnvironmentId ??
                null
              const result =
                remoteHandle && environmentId
                  ? await callRuntimeRpc<{ restored: boolean }>(
                      { kind: 'environment', environmentId },
                      'terminal.restoreFit',
                      { terminal: remoteHandle },
                      { timeoutMs: 15_000 }
                    ).catch(() => ({ restored: false }))
                  : await window.api.runtime
                      .restoreTerminalFit(id)
                      .catch(() => ({ restored: false }))
              if (result.restored) {
                // Why: after the overlay unmounts, focus would otherwise stay on
                // the removed button/body instead of the terminal the user just
                // reclaimed.
                pane.terminal.focus()
              }
            }}
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
