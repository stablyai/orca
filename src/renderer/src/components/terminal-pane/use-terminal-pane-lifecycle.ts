/* eslint-disable max-lines -- Why: terminal pane lifecycle wiring is intentionally co-located so PTY attach, theme sync, and runtime graph publication remain consistent for live terminals. */
import { useEffect, useRef } from 'react'
import type { IDisposable, Terminal } from '@xterm/xterm'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { resolveTerminalCursorInactiveStyle } from '@/lib/pane-manager/pane-terminal-options'
import { useAppStore } from '@/store'
import {
  createFilePathLinkProvider,
  getTerminalFileOpenHint,
  getTerminalUrlOpenHint,
  handleOscLink
} from './terminal-link-handlers'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import type {
  GlobalSettings,
  SetupSplitDirection,
  TerminalLayoutSnapshot
} from '../../../../shared/types'
import type { EventProps } from '../../../../shared/telemetry-events'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import {
  buildFontFamily,
  normalizeTerminalLayoutSnapshot,
  replayTerminalLayout,
  restoreScrollbackBuffers
} from './layout-serialization'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { applyExpandedLayoutTo, restoreExpandedLayoutFrom } from './expand-collapse'
import {
  applyTerminalAppearance,
  installMode2031Handlers,
  mode2031SequenceFor
} from './terminal-appearance'
import { parseOsc52 } from './osc52-clipboard'
import { parseOsc7 } from './parse-osc7'
import { shouldBypassXtermKeydown } from './xterm-bypass-policy'
import type { PaneCwdMap } from './resolve-split-cwd'
import { installMouseHideWhileTyping } from './mouse-hide-while-typing'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import { resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { connectPanePty } from './pty-connection'
import type { PtyTransport } from './pty-transport'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { isPaneReplaying, type ReplayingPanesRef } from './replay-guard'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'
import { registerRuntimeTerminalTab, scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { e2eConfig } from '@/lib/e2e-config'
import {
  PRIMARY_SELECTION_MAX_LENGTH,
  isPrimarySelectionEnabled,
  setPrimarySelectionText
} from '@/lib/primary-selection'
import {
  SPLIT_TERMINAL_PANE_EVENT,
  CLOSE_TERMINAL_PANE_EVENT,
  type SplitTerminalPaneDetail,
  type CloseTerminalPaneDetail
} from '@/constants/terminal'

type UseTerminalPaneLifecycleDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: {
    command: string
    env?: Record<string, string>
    /** Telemetry payload for `agent_started`. Forwarded to `pty:spawn`
     *  so main fires the event only after the spawn succeeds. */
    telemetry?: EventProps<'agent_started'>
  } | null
  /** When present, the initial pane boots clean and a split pane is created
   *  (vertical or horizontal per the user setting) to run the setup command —
   *  keeping the main terminal interactive. */
  setupSplit?: {
    command: string
    env?: Record<string, string>
    direction: SetupSplitDirection
  } | null
  /** When present, a split pane is created to run the repo's configured
   *  issue-automation command with the linked issue number interpolated. */
  issueCommandSplit?: { command: string; env?: Record<string, string> } | null
  isActive: boolean
  systemPrefersDark: boolean
  settings: GlobalSettings | null | undefined
  settingsRef: React.RefObject<GlobalSettings | null | undefined>
  /** Resolved Option-as-Alt value: `'auto'` has already been mapped to
   *  `'true' | 'false'` via the keyboard-layout probe. Passed separately
   *  from `settings` because the probe lives outside the settings store. */
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt
  effectiveMacOptionAsAltRef: React.RefObject<EffectiveMacOptionAsAlt>
  initialLayoutRef: React.RefObject<TerminalLayoutSnapshot>
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  expandedStyleSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  paneFontSizesRef: React.RefObject<Map<number, number>>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  /** Shared map of per-pane live cwd, populated by the OSC 7 handler
   *  installed in onPaneCreated. Exposed to TerminalPane so keyboard and
   *  context-menu split handlers can read it synchronously for cache hits. */
  paneCwdRef: React.RefObject<PaneCwdMap>
  paneMode2031Ref: React.RefObject<Map<number, boolean>>
  paneLastThemeModeRef: React.RefObject<Map<number, 'dark' | 'light'>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  replayingPanesRef: ReplayingPanesRef
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
  clearTabPtyId: (tabId: string, ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  markWorktreeUnread: (worktreeId: string) => void
  markTerminalTabUnread: (tabId: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  dispatchNotification: (event: {
    source: 'terminal-bell' | 'agent-task-complete'
    terminalTitle?: string
  }) => void
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setExpandedPane: (paneId: number | null) => void
  syncExpandedLayout: () => void
  persistLayoutSnapshot: () => void
  setPaneTitles: React.Dispatch<React.SetStateAction<Record<number, string>>>
  paneTitlesRef: React.RefObject<Record<number, string>>
  setRenamingPaneId: React.Dispatch<React.SetStateAction<number | null>>
  // Why: TerminalPane exposes a reactive pane count so effects (e.g. the
  // data-has-title toggler) re-run when panes are split or closed. The
  // imperative managerRef.getPanes().length is not reactive, so without this
  // dispatcher structural changes wouldn't trigger dependent effects.
  setPaneCount: React.Dispatch<React.SetStateAction<number>>
}

function terminalSelectionExceedsPrimaryLimit(terminal: Terminal): boolean {
  const range = terminal.getSelectionPosition()
  if (!range) {
    return false
  }
  const startY = Math.min(range.start.y, range.end.y)
  const endY = Math.max(range.start.y, range.end.y)
  const rowSpan = endY - startY
  const cellEstimate =
    rowSpan === 0
      ? Math.abs(range.end.x - range.start.x)
      : rowSpan * terminal.cols + Math.abs(range.end.x - range.start.x)
  return cellEstimate > PRIMARY_SELECTION_MAX_LENGTH
}

type SplitStartupPayload = { command: string; env?: Record<string, string> }

type SplitWithStartupDeps = {
  startup?: SplitStartupPayload | null
}

/** Scopes `deps.startup` to a single call of `splitPane()`, clearing it in `finally` so later splits do not replay the payload. */
export function splitPaneWithOneShotStartup<TPane>(
  deps: SplitWithStartupDeps,
  startup: SplitStartupPayload,
  splitPane: () => TPane
): TPane {
  // Why: the startup payload is only for the pane created by this split.
  // Pane creation fans out through onPaneCreated using a spread copy of `deps`,
  // so connectPanePty cannot clear the caller's original object for us.
  // Reset the shared field in finally so later user-driven splits never replay
  // setup/issue commands, even if splitPane throws during creation.
  // Relies on manager.splitPane → onPaneCreated → connectPanePty reading
  // `deps.startup` synchronously before returning; if that chain ever becomes
  // async, this helper must switch to awaiting the split before clearing.
  deps.startup = startup
  try {
    return splitPane()
  } finally {
    deps.startup = null
  }
}

export function useTerminalPaneLifecycle({
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
  effectiveMacOptionAsAltRef,
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
  consumeSuppressedPtyExit,
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
}: UseTerminalPaneLifecycleDeps): void {
  const systemPrefersDarkRef = useRef(systemPrefersDark)
  systemPrefersDarkRef.current = systemPrefersDark
  const linkProviderDisposablesRef = useRef(new Map<number, IDisposable>())
  // Why: read settingsRef at fire time so toggling "copy on select" takes
  // effect without recreating panes.
  const selectionDisposablesRef = useRef(new Map<number, IDisposable>())
  const selectionCaptureTimersRef = useRef(new Map<number, number>())
  const mode2031DisposablesRef = useRef(new Map<number, IDisposable[]>())
  const osc52DisposablesRef = useRef(new Map<number, IDisposable>())
  const osc7DisposablesRef = useRef(new Map<number, IDisposable>())
  const mouseHideDisposablesRef = useRef(new Map<number, IDisposable>())

  const applyAppearance = (manager: PaneManager): void => {
    const currentSettings = settingsRef.current
    if (!currentSettings) {
      return
    }
    applyTerminalAppearance(
      manager,
      currentSettings,
      systemPrefersDarkRef.current,
      paneFontSizesRef.current,
      paneTransportsRef.current,
      effectiveMacOptionAsAltRef.current,
      paneMode2031Ref.current,
      paneLastThemeModeRef.current
    )
  }

  const pushMode2031ForPane = (paneId: number): void => {
    let attempts = 0
    const send = (): void => {
      if (!managerRef.current?.getPanes().some((pane) => pane.id === paneId)) {
        return
      }
      const transport = paneTransportsRef.current.get(paneId)
      if (!transport?.isConnected()) {
        // Why: TUIs can subscribe before pty:spawn resolves. Retry briefly so
        // the recorded subscription still receives the initial dark/light seed.
        attempts += 1
        if (attempts < 8) {
          window.setTimeout(send, 25)
        }
        return
      }
      const currentSettings = settingsRef.current
      if (!currentSettings) {
        return
      }
      const { mode } = resolveEffectiveTerminalAppearance(
        currentSettings,
        systemPrefersDarkRef.current
      )
      if (transport.sendInput(mode2031SequenceFor(mode))) {
        paneLastThemeModeRef.current.set(paneId, mode)
      }
    }
    send()
  }

  // Initialize PaneManager instance once
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const expandedStyleSnapshots = expandedStyleSnapshotRef.current
    const paneTransports = paneTransportsRef.current
    const panePtyBindings = panePtyBindingsRef.current
    const linkDisposables = linkProviderDisposablesRef.current
    const selectionDisposables = selectionDisposablesRef.current
    const selectionCaptureTimers = selectionCaptureTimersRef.current
    const mouseHideDisposables = mouseHideDisposablesRef.current
    const worktreePath =
      useAppStore
        .getState()
        .allWorktrees()
        .find((candidate) => candidate.id === worktreeId)?.path ??
      cwd ??
      ''
    const startupCwd = cwd ?? worktreePath
    const pathExistsCache = new Map<string, boolean>()
    const linkDeps: LinkHandlerDeps = {
      worktreeId,
      worktreePath,
      startupCwd,
      managerRef,
      linkProviderDisposablesRef,
      pathExistsCache,
      getRuntimeEnvironmentIdForPane: (paneId) => {
        const ptyId = paneTransportsRef.current.get(paneId)?.getPtyId()
        return ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null
      }
    }
    let resizeRaf: number | null = null
    const queueResizeAll = (focusActive: boolean): void => {
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf)
      }
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        const manager = managerRef.current
        if (!manager) {
          return
        }
        if (focusActive) {
          fitAndFocusPanes(manager)
          return
        }
        fitPanes(manager)
      })
    }

    const syncCanExpandState = (): void => {
      const paneCount = managerRef.current?.getPanes().length ?? 1
      setTabCanExpandPane(tabId, paneCount > 1)
    }

    // Why: publish the current pane count to React state so effects depending
    // on structural changes (e.g. the data-has-title toggler) re-run on
    // split/close. The pane list lives in an imperative PaneManager ref, so
    // without this sync those effects would miss structural-only changes.
    const syncPaneCount = (): void => {
      setPaneCount(managerRef.current?.getPanes().length ?? 0)
    }

    const normalizedInitialLayout = normalizeTerminalLayoutSnapshot(initialLayoutRef.current)
    if (normalizedInitialLayout.changed) {
      initialLayoutRef.current = normalizedInitialLayout.snapshot
      useAppStore.getState().setTabLayout(tabId, normalizedInitialLayout.snapshot)
    }
    let shouldPersistLayout = false
    const ptyDeps = {
      tabId,
      worktreeId,
      cwd,
      startup,
      paneTransportsRef,
      replayingPanesRef,
      isActiveRef,
      isVisibleRef,
      onPtyExitRef,
      onPtyErrorRef,
      clearTabPtyId,
      consumeSuppressedPtyExit,
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
      restoredPtyIdByLeafId: initialLayoutRef.current.ptyIdsByLeafId ?? {}
    }

    const unregisterRuntimeTab = registerRuntimeTerminalTab({
      tabId,
      worktreeId,
      getManager: () => managerRef.current,
      getContainer: () => containerRef.current,
      getPtyIdForPane: (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
    })

    const fileOpenLinkHint = getTerminalFileOpenHint()
    const urlOpenLinkHint = getTerminalUrlOpenHint()

    const manager = new PaneManager(container, {
      // Why: `spawnHints` carries the resolved cwd from Cmd+D / context-menu
      // Split actions so the new PTY inherits the source pane's live cwd.
      // Split-pane CWD inheritance — see docs/ssh-split-pane-inherit-cwd.md.
      onPaneCreated: (pane, spawnHints) => {
        // Install mode 2031 parser handlers before PTY attach so the child's
        // initial CSI ?2031h (sent at startup) is captured.
        const mode2031Disposables = installMode2031Handlers({
          paneId: pane.id,
          parser: pane.terminal.parser,
          onSubscribe: () => pushMode2031ForPane(pane.id),
          isReplaying: () => isPaneReplaying(replayingPanesRef, pane.id),
          paneMode2031: paneMode2031Ref.current,
          paneLastThemeMode: paneLastThemeModeRef.current
        })
        mode2031DisposablesRef.current.set(pane.id, mode2031Disposables)

        // OSC 52 — TUI-initiated clipboard writes (tmux/nvim/fzf/ssh).
        // Why read settingsRef at fire time (not capture): the user may
        // toggle the gate mid-session and we want that to take effect
        // immediately without recreating panes. Return true ("handled") in
        // both the enabled and disabled paths so xterm doesn't fall
        // through to any other OSC 52 handler and so our intentional drop
        // in the disabled path is explicit.
        const osc52Disposable = pane.terminal.parser.registerOscHandler(52, (data) => {
          if (!settingsRef.current?.terminalAllowOsc52Clipboard) {
            return true
          }
          const parsed = parseOsc52(data)
          if (parsed.kind !== 'write') {
            // Queries and malformed payloads are intentionally dropped —
            // answering a query would leak the user's clipboard to any
            // process writing to the PTY.
            return true
          }
          void window.api.ui.writeClipboardText(parsed.text).catch(() => {
            /* ignore clipboard write failures */
          })
          return true
        })
        osc52DisposablesRef.current.set(pane.id, osc52Disposable)

        // OSC 7 — shell-reported current working directory. Drives split-pane
        // cwd inheritance (Cmd+D / Cmd+Shift+D / context-menu Split). Handler
        // install MUST remain before connectPanePty: the cold-restore path
        // replays recorded PTY output into the terminal synchronously from the
        // first PTY read, so a handler registered later would miss the first
        // OSC 7 in replayed scrollback.
        //
        // Why the replay flag is reliable here: replayIntoTerminal increments
        // a per-pane counter BEFORE xterm.write and decrements it in xterm's
        // write-completion callback (replay-guard.ts). xterm parses OSC
        // synchronously as it consumes the buffer, so every OSC 7 emitted
        // during replay is seen with the counter non-zero.
        //
        // Return true so xterm marks the sequence handled. If a future
        // consumer registers on code 7, registration order decides who sees
        // each sequence.
        const osc7Disposable = pane.terminal.parser.registerOscHandler(7, (data) => {
          const cwd = parseOsc7(data)
          if (cwd) {
            const confirmed = !isPaneReplaying(replayingPanesRef, pane.id)
            paneCwdRef.current.set(pane.id, { cwd, confirmed })
          }
          return true
        })
        osc7DisposablesRef.current.set(pane.id, osc7Disposable)

        // Why: let clipboard chords bypass xterm's kitty CSI-u encoder.
        // With vtExtensions.kittyKeyboard on, a CLI that activates progressive
        // enhancement (Codex does, Claude Code does not) makes xterm encode
        // Cmd+C as a CSI-u sequence with cancel=true, which preventDefaults
        // the keydown and suppresses Chromium's native copy event — so the
        // selection never reaches the clipboard. Returning false here short-
        // circuits xterm's _keyDown before the encoder runs, letting the
        // browser copy pipeline and Electron menu accelerators fire normally.
        // See xterm-bypass-policy.ts for the rule derivation (Ghostty/VS Code).
        pane.terminal.attachCustomKeyEventHandler((e) => {
          if (e.type !== 'keydown') {
            return true
          }
          return !shouldBypassXtermKeydown(e, {
            isMac: navigator.userAgent.includes('Mac'),
            hasSelection: pane.terminal.hasSelection()
          })
        })

        const linkProviderDisposable = pane.terminal.registerLinkProvider(
          createFilePathLinkProvider(pane.id, linkDeps, pane.linkTooltip, fileOpenLinkHint)
        )
        linkProviderDisposablesRef.current.set(pane.id, linkProviderDisposable)
        // Why: skip empty selections so clicking to deselect doesn't clobber
        // whatever the user last copied elsewhere.
        const selectionDisposable = pane.terminal.onSelectionChange(() => {
          const shouldWritePrimarySelection = isPrimarySelectionEnabled()
          const shouldWriteClipboard = settingsRef.current?.terminalClipboardOnSelect === true
          if (!shouldWritePrimarySelection && !shouldWriteClipboard) {
            return
          }
          if (!pane.terminal.hasSelection()) {
            return
          }
          if (
            shouldWritePrimarySelection &&
            !shouldWriteClipboard &&
            terminalSelectionExceedsPrimaryLimit(pane.terminal)
          ) {
            return
          }

          if (shouldWritePrimarySelection) {
            const existingTimer = selectionCaptureTimersRef.current.get(pane.id)
            if (existingTimer !== undefined) {
              window.clearTimeout(existingTimer)
            }
            // Why: xterm fires selection changes while dragging; defer the
            // primary-selection clipboard write to avoid clipboard churn.
            const timer = window.setTimeout(() => {
              selectionCaptureTimersRef.current.delete(pane.id)
              if (!isPrimarySelectionEnabled() || !pane.terminal.hasSelection()) {
                return
              }
              if (terminalSelectionExceedsPrimaryLimit(pane.terminal)) {
                return
              }
              const selection = pane.terminal.getSelection()
              if (selection) {
                setPrimarySelectionText(selection)
              }
            }, 100)
            selectionCaptureTimersRef.current.set(pane.id, timer)
          }

          if (!shouldWriteClipboard) {
            return
          }
          const selection = pane.terminal.getSelection()
          if (!selection) {
            return
          }
          void window.api.ui.writeClipboardText(selection).catch(() => {
            /* ignore clipboard write failures */
          })
        })
        selectionDisposablesRef.current.set(pane.id, selectionDisposable)
        // Hide mouse cursor while typing — classic terminal UX, scoped to the
        // pane container so other UI elements keep their cursor.
        if (settingsRef.current?.terminalMouseHideWhileTyping) {
          const mouseHideDisposable = installMouseHideWhileTyping(pane.terminal, pane.container)
          mouseHideDisposablesRef.current.set(pane.id, mouseHideDisposable)
        }
        pane.terminal.options.linkHandler = {
          allowNonHttpProtocols: true,
          activate: (event, text) => {
            handleOscLink(text, event as MouseEvent | undefined, {
              ...linkDeps,
              runtimeEnvironmentId: linkDeps.getRuntimeEnvironmentIdForPane?.(pane.id) ?? null
            })
            // Why: Cmd/Ctrl+clicking a link activates Orca handling (open file,
            // new browser tab, system browser) which can steal focus from the
            // terminal before the click's mouseup reaches ownerDocument. Without
            // that mouseup, xterm's SelectionService leaves its drag-select
            // mousemove listener attached, so returning to the terminal and
            // moving the mouse extends a selection until the next click/Esc.
            // clearSelection() explicitly detaches those listeners (see
            // SelectionService._removeMouseDownListeners).
            pane.terminal.clearSelection()
          },
          // Show bottom-left tooltip on hover for OSC 8 hyperlinks (e.g.
          // GitHub owner/repo#issue references emitted by CLI tools) — same
          // behaviour as the WebLinksAddon provides for plain-text URLs.
          hover: (_event, text) => {
            pane.linkTooltip.textContent = `${text} (${urlOpenLinkHint})`
            pane.linkTooltip.style.display = ''
          },
          leave: () => {
            pane.linkTooltip.style.display = 'none'
          }
        }
        applyAppearance(manager)
        const panePtyBinding = connectPanePty(pane, manager, {
          ...ptyDeps,
          // Why: spread order matters — spawnHints.cwd (inherited from the
          // source pane) must override the tab-level ptyDeps.cwd (worktree
          // root) so Cmd+D splits boot in the live cwd.
          ...(spawnHints?.cwd ? { cwd: spawnHints.cwd } : {}),
          restoredLeafId: pane.leafId
        })
        // Why: connectPanePty receives a spread copy of ptyDeps, so the
        // `deps.startup = undefined` it performs internally only clears its
        // local copy. If we don't also clear the outer ptyDeps.startup here,
        // a later user-initiated splitPane (e.g. Cmd+D, context-menu "Split
        // Right") fires onPaneCreated again with the original startup still
        // attached — which re-runs the initial composer prompt in the newly
        // created pane. Clearing here ensures the initial-startup payload is
        // consumed exactly once, by the first pane. Setup/issue splits
        // inject their own payload via splitPaneWithOneShotStartup, which
        // sets deps.startup immediately before splitPane() and is therefore
        // unaffected by this clear.
        ptyDeps.startup = null
        panePtyBindings.set(pane.id, panePtyBinding)
        syncPaneCount()
        scheduleRuntimeGraphSync()
        queueResizeAll(true)
      },
      onPaneClosed: (paneId, closedPane) => {
        const linkProviderDisposable = linkProviderDisposablesRef.current.get(paneId)
        if (linkProviderDisposable) {
          linkProviderDisposable.dispose()
          linkProviderDisposablesRef.current.delete(paneId)
        }
        const selectionDisposable = selectionDisposablesRef.current.get(paneId)
        if (selectionDisposable) {
          selectionDisposable.dispose()
          selectionDisposablesRef.current.delete(paneId)
        }
        const selectionCaptureTimer = selectionCaptureTimersRef.current.get(paneId)
        if (selectionCaptureTimer !== undefined) {
          window.clearTimeout(selectionCaptureTimer)
          selectionCaptureTimersRef.current.delete(paneId)
        }
        const mode2031Disposables = mode2031DisposablesRef.current.get(paneId)
        if (mode2031Disposables) {
          for (const d of mode2031Disposables) {
            d.dispose()
          }
          mode2031DisposablesRef.current.delete(paneId)
        }
        paneMode2031Ref.current.delete(paneId)
        paneLastThemeModeRef.current.delete(paneId)
        const osc52Disposable = osc52DisposablesRef.current.get(paneId)
        if (osc52Disposable) {
          osc52Disposable.dispose()
          osc52DisposablesRef.current.delete(paneId)
        }
        const osc7Disposable = osc7DisposablesRef.current.get(paneId)
        if (osc7Disposable) {
          osc7Disposable.dispose()
          osc7DisposablesRef.current.delete(paneId)
        }
        // Why: drop the tracked cwd so the map doesn't accumulate dead
        // entries across splits/closes over long sessions.
        paneCwdRef.current.delete(paneId)
        const mouseHideDisposable = mouseHideDisposablesRef.current.get(paneId)
        if (mouseHideDisposable) {
          mouseHideDisposable.dispose()
          mouseHideDisposablesRef.current.delete(paneId)
        }
        const transport = paneTransportsRef.current.get(paneId)
        const panePtyBinding = panePtyBindings.get(paneId)
        if (panePtyBinding) {
          panePtyBinding.dispose()
          panePtyBindings.delete(paneId)
        }
        if (transport) {
          const ptyId = transport.getPtyId()
          if (ptyId) {
            syncPanePtyLayoutBinding(paneId, null)
            clearTabPtyId(tabId, ptyId)
          }
          // Why: closing a pane is user-initiated teardown of this row — drop
          // (not remove) so any retained `done` snapshot for this pane is also
          // cleared and a same-frame live→gone transition cannot re-snapshot
          // it via the retention sync.
          const leafId = closedPane?.leafId
          if (leafId) {
            const paneKey = makePaneKey(tabId, leafId)
            useAppStore.getState().setCacheTimerStartedAt(paneKey, null)
            useAppStore.getState().dropAgentStatus(paneKey)
          }
          transport.destroy?.()
          paneTransportsRef.current.delete(paneId)
        }
        clearRuntimePaneTitle(tabId, paneId)
        paneFontSizesRef.current.delete(paneId)
        replayingPanesRef.current.delete(paneId)
        // Clean up pane title state so closed panes don't leave stale entries.
        setPaneTitles((prev) => {
          if (!(paneId in prev)) {
            return prev
          }
          const next = { ...prev }
          delete next[paneId]
          return next
        })
        // Eagerly update the ref so persistLayoutSnapshot (called from
        // onLayoutChanged which fires right after onPaneClosed) reads the
        // correct titles without waiting for React's async state flush.
        if (paneId in paneTitlesRef.current) {
          const next = { ...paneTitlesRef.current }
          delete next[paneId]
          paneTitlesRef.current = next
        }
        // Dismiss the rename dialog if it was open for the closed pane,
        // otherwise it would submit against a non-existent pane.
        setRenamingPaneId((prev) => (prev === paneId ? null : prev))
        syncPaneCount()
        // Why: PaneManager.closePane() reassigns activePaneId directly without
        // calling setActivePane(), so onActivePaneChange does not fire. Sync the
        // tab title to the survivor's stored title here so the tab label doesn't
        // stay stuck on the closed pane's last title.
        const newActivePane = managerRef.current?.getActivePane()
        if (newActivePane) {
          const paneTitles = useAppStore.getState().runtimePaneTitlesByTabId[tabId] ?? {}
          const activeTitle = paneTitles[newActivePane.id]
          if (activeTitle) {
            updateTabTitle(tabId, activeTitle)
          }
        }
        scheduleRuntimeGraphSync()
      },
      onActivePaneChange: (pane) => {
        scheduleRuntimeGraphSync()
        if (shouldPersistLayout) {
          persistLayoutSnapshot()
        }
        // Why: when the user switches focus between split panes, update the
        // tab title to the newly active pane's last-known title so the tab
        // label reflects the focused agent — not a stale title from the
        // previously focused pane.
        const paneTitles = useAppStore.getState().runtimePaneTitlesByTabId[tabId] ?? {}
        const paneTitle = paneTitles[pane.id]
        if (paneTitle) {
          updateTabTitle(tabId, paneTitle)
        }
      },
      onLayoutChanged: () => {
        scheduleRuntimeGraphSync()
        syncExpandedLayout()
        syncCanExpandState()
        syncPaneCount()
        queueResizeAll(false)
        if (shouldPersistLayout) {
          persistLayoutSnapshot()
        }
      },
      terminalOptions: () => {
        const currentSettings = settingsRef.current
        const terminalFontWeights = resolveTerminalFontWeights(currentSettings?.terminalFontWeight)
        const cursorStyle = currentSettings?.terminalCursorStyle ?? 'bar'
        return {
          fontSize: currentSettings?.terminalFontSize ?? 14,
          fontFamily: buildFontFamily(currentSettings?.terminalFontFamily ?? ''),
          fontWeight: terminalFontWeights.fontWeight,
          fontWeightBold: terminalFontWeights.fontWeightBold,
          scrollback: Math.min(
            50_000,
            Math.max(
              1000,
              Math.round((currentSettings?.terminalScrollbackBytes ?? 10_000_000) / 200)
            )
          ),
          cursorStyle,
          cursorInactiveStyle: resolveTerminalCursorInactiveStyle(cursorStyle),
          cursorBlink: currentSettings?.terminalCursorBlink ?? true,
          macOptionIsMeta: effectiveMacOptionAsAltRef.current === 'true',
          lineHeight: currentSettings?.terminalLineHeight ?? 1,
          wordSeparator: currentSettings?.terminalWordSeparator
        }
      },
      onLinkClick: (event, url) => {
        if (!event) {
          return
        }
        const activePane = managerRef.current?.getActivePane()
        void handleOscLink(url, event, {
          ...linkDeps,
          runtimeEnvironmentId: activePane
            ? (linkDeps.getRuntimeEnvironmentIdForPane?.(activePane.id) ?? null)
            : null
        })
        // Why: Cmd/Ctrl+click on a plain-text URL (WebLinksAddon) takes focus
        // away from the terminal before the click's mouseup reaches
        // ownerDocument. That leaves xterm's SelectionService drag-select
        // mousemove listener attached, so subsequent mouse motion extends a
        // phantom selection until the next click/Esc. Explicitly clearing the
        // selection also detaches those listeners (see
        // SelectionService._removeMouseDownListeners).
        managerRef.current?.getActivePane()?.terminal.clearSelection()
      },
      // Why: TerminalPane instances stay mounted for hidden visited worktrees
      // so PTYs survive navigation. Creating WebGL for those offscreen panes
      // still consumes Chromium's context budget and can blank visible panes.
      initialRenderingSuspended: !isVisibleRef.current,
      terminalGpuAcceleration: settingsRef.current?.terminalGpuAcceleration ?? 'auto',
      debugLabel: `tab:${tabId}/wt:${worktreeId}`
    })

    managerRef.current = manager
    // Why: E2E tests need to read terminal buffer content, but xterm.js renders
    // to canvas and the accessibility addon is not loaded. Exposing the manager
    // lets tests call serializeAddon.serialize() to read the buffer reliably.
    if (e2eConfig.exposeStore) {
      window.__paneManagers = window.__paneManagers ?? new Map()
      window.__paneManagers.set(tabId, manager)
    }
    const restoredPaneByLeafId = replayTerminalLayout(manager, initialLayoutRef.current, isActive)

    restoreScrollbackBuffers(
      manager,
      initialLayoutRef.current.buffersByLeafId,
      restoredPaneByLeafId,
      replayingPanesRef
    )

    // Seed pane titles from the persisted snapshot using the same
    // old-leafId → new-paneId mapping used for buffer restore.
    const savedTitles = initialLayoutRef.current.titlesByLeafId
    if (savedTitles) {
      const restored: Record<number, string> = {}
      for (const [oldLeafId, title] of Object.entries(savedTitles)) {
        const newPaneId = restoredPaneByLeafId.get(oldLeafId)
        if (newPaneId != null && title) {
          restored[newPaneId] = title
        }
      }
      if (Object.keys(restored).length > 0) {
        // Merge (not replace) so we don't discard any concurrent state
        // updates from onPaneClosed that React may have batched.
        setPaneTitles((prev) => ({ ...prev, ...restored }))
      }
    }

    const restoredActivePaneId =
      (initialLayoutRef.current.activeLeafId
        ? restoredPaneByLeafId.get(initialLayoutRef.current.activeLeafId)
        : null) ??
      manager.getActivePane()?.id ??
      manager.getPanes()[0]?.id ??
      null
    if (restoredActivePaneId !== null) {
      manager.setActivePane(restoredActivePaneId, { focus: isActive })
    }
    const restoredExpandedPaneId = initialLayoutRef.current.expandedLeafId
      ? (restoredPaneByLeafId.get(initialLayoutRef.current.expandedLeafId) ?? null)
      : null
    if (restoredExpandedPaneId !== null && manager.getPanes().length > 1) {
      setExpandedPane(restoredExpandedPaneId)
      applyExpandedLayoutTo(restoredExpandedPaneId, {
        managerRef,
        containerRef,
        expandedStyleSnapshotRef
      })
    } else {
      setExpandedPane(null)
    }
    // Why: setup split creates a right-side pane for the setup script so the
    // main (left) terminal stays immediately usable. We inject the setup command
    // into ptyDeps.startup right before splitting and clear it immediately after
    // — connectPanePty receives a spread copy (`{...ptyDeps}`), so mutations
    // inside connectPanePty don't propagate back to ptyDeps. Without clearing
    // here, any later user-initiated split (e.g. Cmd+D) would re-run the setup
    // command in the newly created pane.
    let issueAutomationAnchorPaneId: number | null = null
    // Why: capture the main shell pane *before* any splits mutate the pane list.
    // Both the setup and issue-command paths need to restore focus back to this
    // pane after creating their splits, so we save the reference once rather
    // than relying on getPanes()[0] which returns insertion order, not visual order.
    const initialPane = manager.getActivePane() ?? manager.getPanes()[0]

    if (setupSplit) {
      if (initialPane) {
        const setupPane = splitPaneWithOneShotStartup(
          ptyDeps,
          { command: setupSplit.command, env: setupSplit.env },
          () => manager.splitPane(initialPane.id, setupSplit.direction)
        )
        issueAutomationAnchorPaneId = setupPane?.id ?? null
        // Restore focus to the main pane so the user's terminal receives
        // keyboard input — the setup pane runs unattended.
        manager.setActivePane(initialPane.id, { focus: isActive })
      }
    }

    // Why: when the user links a GitHub issue during worktree creation and has
    // enabled that repo's issue automation, spawn a separate split pane to run
    // the agent command. This runs independently from setup: the issue command
    // is a per-user prompt/template rather than repo bootstrap, so Orca should
    // not guess at ordering requirements that vary by user workflow.
    if (issueCommandSplit) {
      let targetPane = manager.getActivePane() ?? manager.getPanes()[0] ?? null
      if (issueAutomationAnchorPaneId !== null) {
        // Why: keep the same anchor-first fallback order without the ternary +
        // nullish chain that `tsgo` currently misreads as always-nullish.
        targetPane =
          manager.getPanes().find((pane) => pane.id === issueAutomationAnchorPaneId) ?? targetPane
      }
      if (targetPane) {
        splitPaneWithOneShotStartup(
          ptyDeps,
          { command: issueCommandSplit.command, env: issueCommandSplit.env },
          () => manager.splitPane(targetPane.id, 'vertical')
        )
        // Why: if setup already claimed the right half, nest issue automation
        // inside that automation area instead of splitting the main shell again.
        // This preserves the primary terminal as the dominant pane while setup
        // and issue panes share the secondary column.
        const focusPaneId =
          issueAutomationAnchorPaneId !== null ? (initialPane?.id ?? targetPane.id) : targetPane.id
        manager.setActivePane(focusPaneId, { focus: isActive })
      }
    }

    shouldPersistLayout = true
    syncCanExpandState()
    syncPaneCount()
    applyAppearance(manager)
    queueResizeAll(isActive)
    persistLayoutSnapshot()
    scheduleRuntimeGraphSync()

    // Why: CLI-driven splits go through splitPaneWithOneShotStartup so the
    // startup command is delivered via the PTY connection path (which waits
    // for shell readiness) instead of terminal.paste() which can lose input
    // if the shell hasn't started reading stdin yet.
    function onCliSplitPane(event: Event): void {
      const detail = (event as CustomEvent<SplitTerminalPaneDetail>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const mgr = managerRef.current
      if (!mgr) {
        return
      }
      if (detail.command) {
        splitPaneWithOneShotStartup(ptyDeps, { command: detail.command }, () =>
          mgr.splitPane(detail.paneRuntimeId, detail.direction)
        )
      } else {
        mgr.splitPane(detail.paneRuntimeId, detail.direction)
      }
    }
    window.addEventListener(SPLIT_TERMINAL_PANE_EVENT, onCliSplitPane)

    // Why: CLI-driven pane close dispatches a CustomEvent so PaneManager handles
    // sibling promotion in split layouts. Falls back to closing the whole tab
    // when the target pane is the only one remaining.
    function onCliClosePane(event: Event): void {
      const detail = (event as CustomEvent<CloseTerminalPaneDetail>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const mgr = managerRef.current
      if (!mgr) {
        return
      }
      if (mgr.getPanes().length <= 1) {
        useAppStore.getState().closeTab(tabId)
      } else {
        mgr.closePane(detail.paneRuntimeId)
        scheduleRuntimeGraphSync()
        syncCanExpandState()
        queueResizeAll(isActive)
        persistLayoutSnapshot()
      }
    }
    window.addEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)

    return () => {
      window.removeEventListener(SPLIT_TERMINAL_PANE_EVENT, onCliSplitPane)
      window.removeEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
      const tabStillExists = Boolean(
        useAppStore
          .getState()
          .tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
      )
      unregisterRuntimeTab()
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf)
      }
      restoreExpandedLayoutFrom(expandedStyleSnapshots)
      for (const disposable of linkDisposables.values()) {
        disposable.dispose()
      }
      linkDisposables.clear()
      for (const disposable of selectionDisposables.values()) {
        disposable.dispose()
      }
      selectionDisposables.clear()
      for (const timer of selectionCaptureTimers.values()) {
        window.clearTimeout(timer)
      }
      selectionCaptureTimers.clear()
      for (const disposable of mouseHideDisposables.values()) {
        disposable.dispose()
      }
      mouseHideDisposables.clear()
      for (const transport of paneTransports.values()) {
        if (tabStillExists && transport.getPtyId()) {
          // Why: moving a terminal tab between groups currently rehomes the
          // React subtree, which unmounts this TerminalPane even though the tab
          // itself is still alive. Detaching preserves the running PTY so the
          // remounted pane can reattach without restarting the user's shell.
          // Transports that have not attached yet still have no PTY ID; those
          // must be destroyed so any in-flight spawn resolves into a killed PTY
          // instead of reviving a stale binding after unmount.
          transport.detach?.()
        } else {
          transport.destroy?.()
        }
      }
      for (const panePtyBinding of panePtyBindings.values()) {
        panePtyBinding.dispose()
      }
      panePtyBindings.clear()
      paneTransports.clear()
      manager.destroy()
      managerRef.current = null
      if (e2eConfig.exposeStore) {
        window.__paneManagers?.delete(tabId)
      }
      setTabPaneExpanded(tabId, false)
      setTabCanExpandPane(tabId, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, cwd])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !settings) {
      return
    }
    applyAppearance(manager)
    // Why: effectiveMacOptionAsAlt changes when the OS keyboard layout
    // switches mid-session (focus-in probe re-runs) or when the user flips
    // the explicit override. Either triggers a live re-apply of
    // macOptionIsMeta on every pane so the change takes effect
    // immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, systemPrefersDark, effectiveMacOptionAsAlt])

  useEffect(() => {
    managerRef.current?.setTerminalGpuAcceleration(settings?.terminalGpuAcceleration ?? 'auto')
  }, [settings?.terminalGpuAcceleration, managerRef])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const hide = settings?.terminalMouseHideWhileTyping ?? false
    for (const pane of manager.getPanes()) {
      const existing = mouseHideDisposablesRef.current.get(pane.id)
      if (hide && !existing) {
        const disposable = installMouseHideWhileTyping(pane.terminal, pane.container)
        mouseHideDisposablesRef.current.set(pane.id, disposable)
      } else if (!hide && existing) {
        existing.dispose()
        mouseHideDisposablesRef.current.delete(pane.id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.terminalMouseHideWhileTyping])
}
