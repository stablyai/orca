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
import { EMPTY_LAYOUT, paneLeafId, serializeTerminalLayout } from './layout-serialization'
import { createExpandCollapseActions } from './expand-collapse'
import { useTerminalKeyboardShortcuts, type SearchState } from './keyboard-handlers'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { useTerminalFontZoom } from './useTerminalFontZoom'
import CloseTerminalDialog from './CloseTerminalDialog'
import { TerminalErrorToast } from './TerminalErrorToast'
import TerminalContextMenu from './TerminalContextMenu'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { useTerminalPaneLifecycle } from './use-terminal-pane-lifecycle'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import { useNotificationDispatch } from './use-notification-dispatch'
import { connectPanePty } from './pty-connection'

/** Global set of buffer-capture callbacks, one per mounted TerminalPane.
 *  The beforeunload handler in App.tsx invokes every callback to populate
 *  Zustand with serialized buffers before flushing the session to disk. */
export const shutdownBufferCaptures = new Set<() => void>()

const MAX_BUFFER_BYTES = 512 * 1024

type TerminalPaneProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible?: boolean
  onPtyExit: (ptyId: string) => void
  onCloseTab: () => void
}

export default function TerminalPane({
  tabId,
  worktreeId,
  cwd,
  isActive,
  isVisible = true,
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
  const paneTransportsRef = useRef<Map<number, PtyTransport>>(new Map())
  const paneMode2031Ref = useRef<Map<number, boolean>>(new Map())
  const paneLastThemeModeRef = useRef<Map<number, 'dark' | 'light'>>(new Map())
  const panePtyBindingsRef = useRef<Map<number, IDisposable>>(new Map())
  const pendingWritesRef = useRef<Map<number, string>>(new Map())
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
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  const searchStateRef = useRef<SearchState>({ query: '', caseSensitive: false, regex: false })
  const [closeConfirmPaneId, setCloseConfirmPaneId] = useState<number | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)

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
    const layout = serializeTerminalLayout(container, activePaneId, expandedPaneIdRef.current)
    // Preserve existing buffersByLeafId so layout-only persists (resize, split,
    // reorder) don't clobber previously captured scrollback.
    const existing = useAppStore.getState().terminalLayoutsByTabId[tabId]
    if (existing?.buffersByLeafId) {
      const currentLeafIds = new Set(manager.getPanes().map((p) => paneLeafId(p.id)))
      layout.buffersByLeafId = Object.fromEntries(
        Object.entries(existing.buffersByLeafId).filter(([id]) => currentLeafIds.has(id))
      )
    }
    // Why: between pane creation and the deferred rAF where PTYs actually
    // attach, all transports have getPtyId() === null. If persistLayoutSnapshot
    // fires during that window the live-transport block below finds no entries,
    // so this block preserves the *prior* snapshot's leaf→PTY mappings. Without
    // it, a rapid successive remount (tab moved again before the first rAF)
    // would lose the mappings and force fresh PTY spawns.
    if (existing?.ptyIdsByLeafId) {
      const currentLeafIds = new Set(manager.getPanes().map((p) => paneLeafId(p.id)))
      layout.ptyIdsByLeafId = Object.fromEntries(
        Object.entries(existing.ptyIdsByLeafId).filter(([id]) => currentLeafIds.has(id))
      )
    }
    // Preserve pane titles — uses the live React state (via ref) rather than
    // the stale Zustand value because React state reflects in-flight title
    // edits that haven't been persisted yet.
    const currentPanes = manager.getPanes()
    const ptyEntries = currentPanes
      .map(
        (p) => [paneLeafId(p.id), paneTransportsRef.current.get(p.id)?.getPtyId() ?? null] as const
      )
      .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    if (ptyEntries.length > 0) {
      layout.ptyIdsByLeafId = Object.fromEntries(ptyEntries)
    }
    const titles = paneTitlesRef.current
    const titleEntries = currentPanes
      .filter((p) => titles[p.id])
      .map((p) => [paneLeafId(p.id), titles[p.id]] as const)
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
      const leafId = paneLeafId(paneId)

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
        useAppStore.getState().setCacheTimerStartedAt(`${tabId}:${paneId}`, null)
        syncPanePtyLayoutBinding(paneId, null)
        manager.closePane(paneId)
      }
    },
    [onCloseTab, syncPanePtyLayoutBinding, tabId]
  )

  // Cmd+W handler — shows a Ghostty-style confirmation dialog when the
  // pane's shell has a running child process (e.g. npm run dev), so the
  // user doesn't accidentally kill it. An idle shell prompt closes
  // immediately. Ctrl+D (explicit EOF) bypasses this by design.
  const handleRequestClosePane = useCallback(
    (paneId: number) => {
      const transport = paneTransportsRef.current.get(paneId)
      const ptyId = transport?.getPtyId()
      if (!ptyId) {
        executeClosePane(paneId)
        return
      }
      void window.api.pty.hasChildProcesses(ptyId).then((hasChildren) => {
        if (hasChildren) {
          setCloseConfirmPaneId(paneId)
        } else {
          executeClosePane(paneId)
        }
      })
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
    paneMode2031Ref,
    paneLastThemeModeRef,
    panePtyBindingsRef,
    pendingWritesRef,
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
    setRenamingPaneId
  })

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
      setCacheTimerStartedAt(`${tabId}:${paneId}`, null)
      setTerminalError(null)

      const newPaneBinding = connectPanePty(pane, manager, {
        tabId,
        worktreeId,
        cwd,
        startup: { command: 'codex' },
        paneTransportsRef,
        pendingWritesRef,
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
    managerRef,
    paneTransportsRef,
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
    isActive,
    isVisible,
    managerRef,
    containerRef,
    paneTransportsRef,
    pendingWritesRef,
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
    const captureBuffers = (): void => {
      const manager = managerRef.current
      const container = containerRef.current
      if (!manager || !container) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length === 0) {
        return
      }
      // Flush pending background PTY output into terminals before serializing.
      // terminal.write() is async so some trailing bytes may be lost — best effort.
      for (const pane of panes) {
        const pending = pendingWritesRef.current.get(pane.id)
        if (pending) {
          pane.terminal.write(pending)
          pendingWritesRef.current.set(pane.id, '')
        }
      }
      const buffers: Record<string, string> = {}
      for (const pane of panes) {
        try {
          const leafId = paneLeafId(pane.id)
          let scrollback = pane.terminal.options.scrollback ?? 10_000
          let serialized = pane.serializeAddon.serialize({ scrollback })
          // Cap at 512KB — binary search for largest scrollback that fits.
          if (serialized.length > MAX_BUFFER_BYTES && scrollback > 1) {
            let lo = 1
            let hi = scrollback
            let best = ''
            while (lo <= hi) {
              const mid = Math.floor((lo + hi) / 2)
              const attempt = pane.serializeAddon.serialize({ scrollback: mid })
              if (attempt.length <= MAX_BUFFER_BYTES) {
                best = attempt
                lo = mid + 1
              } else {
                hi = mid - 1
              }
            }
            serialized = best
          }
          if (serialized.length > 0) {
            buffers[leafId] = serialized
          }
        } catch {
          // Serialization failure for one pane should not block others.
        }
      }
      const activePaneId = manager.getActivePane()?.id ?? panes[0]?.id ?? null
      const layout = serializeTerminalLayout(container, activePaneId, expandedPaneIdRef.current)
      if (Object.keys(buffers).length > 0) {
        layout.buffersByLeafId = buffers
      }
      const ptyEntries = panes
        .map(
          (pane) =>
            [
              paneLeafId(pane.id),
              paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
            ] as const
        )
        .filter((entry): entry is readonly [string, string] => entry[1] !== null)
      if (ptyEntries.length > 0) {
        layout.ptyIdsByLeafId = Object.fromEntries(ptyEntries)
      }
      // Merge pane titles so the shutdown snapshot doesn't silently drop them.
      // Why: the old early-return on empty buffers skipped this entirely, which
      // meant titles were lost on restart when the terminal had no scrollback
      // content (e.g. fresh pane, cleared screen).
      const titleEntries = panes
        .filter((p) => paneTitlesRef.current[p.id])
        .map((p) => [paneLeafId(p.id), paneTitlesRef.current[p.id]] as const)
      if (titleEntries.length > 0) {
        layout.titlesByLeafId = Object.fromEntries(titleEntries)
      }
      setTabLayout(tabId, layout)
    }
    shutdownBufferCaptures.add(captureBuffers)
    return () => {
      shutdownBufferCaptures.delete(captureBuffers)
    }
  }, [tabId, setTabLayout])

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
          transport.sendInput(shellEscapePath(filePath))
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
        menuPaneIsExpanded={
          contextMenu.menuPaneId !== null && contextMenu.menuPaneId === expandedPaneId
        }
        onCopy={() => void contextMenu.onCopy()}
        onPaste={() => void contextMenu.onPaste()}
        onSplitRight={contextMenu.onSplitRight}
        onSplitDown={contextMenu.onSplitDown}
        onClosePane={contextMenu.onClosePane}
        onClearScreen={contextMenu.onClearScreen}
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
      {managerRef.current?.getPanes().map((pane) => {
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
      <CloseTerminalDialog
        open={closeConfirmPaneId !== null}
        onCancel={() => setCloseConfirmPaneId(null)}
        onConfirm={handleConfirmClose}
      />
    </>
  )
}
