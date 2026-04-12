/* eslint-disable max-lines -- Why: terminal pane lifecycle wiring is intentionally co-located so PTY attach, theme sync, and runtime graph publication remain consistent for live terminals. */
import { useEffect, useRef } from 'react'
import type { IDisposable } from '@xterm/xterm'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import {
  createFilePathLinkProvider,
  getTerminalFileOpenHint,
  getTerminalUrlOpenHint,
  handleOscLink
} from './terminal-link-handlers'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import type { GlobalSettings, TerminalLayoutSnapshot } from '../../../../shared/types'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import {
  buildFontFamily,
  replayTerminalLayout,
  restoreScrollbackBuffers
} from './layout-serialization'
import { applyExpandedLayoutTo, restoreExpandedLayoutFrom } from './expand-collapse'
import { applyTerminalAppearance } from './terminal-appearance'
import { connectPanePty } from './pty-connection'
import type { PtyTransport } from './pty-transport'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'
import { registerRuntimeTerminalTab, scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'

type UseTerminalPaneLifecycleDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: { command: string; env?: Record<string, string> } | null
  /** When present, the initial pane boots clean and a right-side split pane is
   *  created to run the setup command — keeping the main terminal interactive. */
  setupSplit?: { command: string; env?: Record<string, string> } | null
  /** When present, a split pane is created to run the repo's configured
   *  issue-automation command with the linked issue number interpolated. */
  issueCommandSplit?: { command: string; env?: Record<string, string> } | null
  isActive: boolean
  systemPrefersDark: boolean
  settings: GlobalSettings | null | undefined
  settingsRef: React.RefObject<GlobalSettings | null | undefined>
  initialLayoutRef: React.RefObject<TerminalLayoutSnapshot>
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  expandedStyleSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  paneFontSizesRef: React.RefObject<Map<number, number>>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  pendingWritesRef: React.RefObject<Map<number, string>>
  isActiveRef: React.RefObject<boolean>
  effectiveVisibleRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
  clearTabPtyId: (tabId: string, ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  markWorktreeUnread: (worktreeId: string) => void
  dispatchNotification: (event: {
    source: 'agent-task-complete' | 'terminal-bell'
    terminalTitle?: string
  }) => void
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setExpandedPane: (paneId: number | null) => void
  syncExpandedLayout: () => void
  persistLayoutSnapshot: () => void
  setPaneTitles: React.Dispatch<React.SetStateAction<Record<number, string>>>
  paneTitlesRef: React.RefObject<Record<number, string>>
  setRenamingPaneId: React.Dispatch<React.SetStateAction<number | null>>
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
  initialLayoutRef,
  managerRef,
  containerRef,
  expandedStyleSnapshotRef,
  paneFontSizesRef,
  paneTransportsRef,
  panePtyBindingsRef,
  pendingWritesRef,
  isActiveRef,
  effectiveVisibleRef,
  onPtyExitRef,
  onPtyErrorRef,
  clearTabPtyId,
  consumeSuppressedPtyExit,
  updateTabTitle,
  setRuntimePaneTitle,
  clearRuntimePaneTitle,
  updateTabPtyId,
  markWorktreeUnread,
  dispatchNotification,
  setCacheTimerStartedAt,
  setTabPaneExpanded,
  setTabCanExpandPane,
  setExpandedPane,
  syncExpandedLayout,
  persistLayoutSnapshot,
  setPaneTitles,
  paneTitlesRef,
  setRenamingPaneId
}: UseTerminalPaneLifecycleDeps): void {
  const systemPrefersDarkRef = useRef(systemPrefersDark)
  systemPrefersDarkRef.current = systemPrefersDark
  const linkProviderDisposablesRef = useRef(new Map<number, IDisposable>())

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
      paneTransportsRef.current
    )
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
    const pendingWrites = pendingWritesRef.current
    const linkDisposables = linkProviderDisposablesRef.current
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
      pathExistsCache
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

    let shouldPersistLayout = false
    const ptyDeps = {
      tabId,
      worktreeId,
      cwd,
      startup,
      restoredPtyIdByPaneId: new Map<number, string>(),
      paneTransportsRef,
      pendingWritesRef,
      isActiveRef,
      effectiveVisibleRef,
      onPtyExitRef,
      onPtyErrorRef,
      clearTabPtyId,
      consumeSuppressedPtyExit,
      updateTabTitle,
      setRuntimePaneTitle,
      clearRuntimePaneTitle,
      updateTabPtyId,
      markWorktreeUnread,
      dispatchNotification,
      setCacheTimerStartedAt
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
      onPaneCreated: (pane) => {
        const linkProviderDisposable = pane.terminal.registerLinkProvider(
          createFilePathLinkProvider(pane.id, linkDeps, pane.linkTooltip, fileOpenLinkHint)
        )
        linkProviderDisposablesRef.current.set(pane.id, linkProviderDisposable)
        pane.terminal.options.linkHandler = {
          allowNonHttpProtocols: true,
          activate: (event, text) => handleOscLink(text, event as MouseEvent | undefined, linkDeps),
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
        const panePtyBinding = connectPanePty(pane, manager, ptyDeps)
        panePtyBindings.set(pane.id, panePtyBinding)
        scheduleRuntimeGraphSync()
        queueResizeAll(true)
      },
      onPaneClosed: (paneId) => {
        const linkProviderDisposable = linkProviderDisposablesRef.current.get(paneId)
        if (linkProviderDisposable) {
          linkProviderDisposable.dispose()
          linkProviderDisposablesRef.current.delete(paneId)
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
            clearTabPtyId(tabId, ptyId)
          }
          transport.destroy?.()
          paneTransportsRef.current.delete(paneId)
        }
        clearRuntimePaneTitle(tabId, paneId)
        paneFontSizesRef.current.delete(paneId)
        pendingWritesRef.current.delete(paneId)
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
        scheduleRuntimeGraphSync()
      },
      onActivePaneChange: () => {
        scheduleRuntimeGraphSync()
        if (shouldPersistLayout) {
          persistLayoutSnapshot()
        }
      },
      onLayoutChanged: () => {
        scheduleRuntimeGraphSync()
        syncExpandedLayout()
        syncCanExpandState()
        queueResizeAll(false)
        if (shouldPersistLayout) {
          persistLayoutSnapshot()
        }
      },
      terminalOptions: () => {
        const currentSettings = settingsRef.current
        const terminalFontWeights = resolveTerminalFontWeights(currentSettings?.terminalFontWeight)
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
          cursorStyle: currentSettings?.terminalCursorStyle ?? 'bar',
          cursorBlink: currentSettings?.terminalCursorBlink ?? true
        }
      },
      onLinkClick: (event, url) => {
        if (!event) {
          return
        }
        void handleOscLink(url, event, linkDeps)
      }
    })

    managerRef.current = manager
    const restoredPaneByLeafId = replayTerminalLayout(manager, initialLayoutRef.current, isActive)

    // Why: populate the per-pane PTY ID map *synchronously* after replay but
    // before the rAF callbacks in connectPanePty fire. replayTerminalLayout
    // creates panes (scheduling rAFs for PTY attach), then returns the
    // old-leafId → new-paneId mapping. We translate the snapshot's
    // leafId → ptyId entries into paneId → ptyId here so the deferred rAFs
    // can look up the correct PTY for each pane.
    const savedPtyIds = initialLayoutRef.current.ptyIdsByLeafId
    if (savedPtyIds) {
      for (const [leafId, ptyId] of Object.entries(savedPtyIds)) {
        const paneId = restoredPaneByLeafId.get(leafId)
        if (paneId != null) {
          ptyDeps.restoredPtyIdByPaneId.set(paneId, ptyId)
        }
      }
    }

    restoreScrollbackBuffers(
      manager,
      initialLayoutRef.current.buffersByLeafId,
      restoredPaneByLeafId
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
    // into ptyDeps.startup right before splitting — connectPanePty (called from
    // onPaneCreated) reads it synchronously and clears it, so only the new pane
    // gets the command. The initial pane already consumed startup=null above.
    let issueAutomationAnchorPaneId: number | null = null
    // Why: capture the main shell pane *before* any splits mutate the pane list.
    // Both the setup and issue-command paths need to restore focus back to this
    // pane after creating their splits, so we save the reference once rather
    // than relying on getPanes()[0] which returns insertion order, not visual order.
    const initialPane = manager.getActivePane() ?? manager.getPanes()[0]

    if (setupSplit) {
      if (initialPane) {
        ptyDeps.startup = { command: setupSplit.command, env: setupSplit.env }
        const setupPane = manager.splitPane(initialPane.id, 'vertical')
        issueAutomationAnchorPaneId = setupPane?.id ?? null
        // Restore focus to the main (left) pane so the user's terminal
        // receives keyboard input — the setup pane runs unattended.
        manager.setActivePane(initialPane.id, { focus: isActive })
      }
    }

    // Why: when the user links a GitHub issue during worktree creation and has
    // enabled that repo's issue automation, spawn a separate split pane to run
    // the agent command. This runs independently from setup: the issue command
    // is a per-user prompt/template rather than repo bootstrap, so Orca should
    // not guess at ordering requirements that vary by user workflow.
    if (issueCommandSplit) {
      const targetPane =
        (issueAutomationAnchorPaneId !== null
          ? (manager.getPanes().find((pane) => pane.id === issueAutomationAnchorPaneId) ?? null)
          : null) ??
        manager.getActivePane() ??
        manager.getPanes()[0]
      if (targetPane) {
        ptyDeps.startup = { command: issueCommandSplit.command, env: issueCommandSplit.env }
        manager.splitPane(targetPane.id, 'vertical')
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
    applyAppearance(manager)
    queueResizeAll(isActive)
    persistLayoutSnapshot()
    scheduleRuntimeGraphSync()

    return () => {
      unregisterRuntimeTab()
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf)
      }
      restoreExpandedLayoutFrom(expandedStyleSnapshots)
      for (const disposable of linkDisposables.values()) {
        disposable.dispose()
      }
      linkDisposables.clear()
      const terminalTabStillExists = (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).some(
        (tab) => tab.id === tabId
      )
      for (const transport of paneTransports.values()) {
        if (terminalTabStillExists && transport.getPtyId()) {
          // Why: only preserve PTYs when this unmount is a layout-only remount
          // and the terminal tab still exists in store. Real close paths remove
          // the tab before React unmounts, so preserving here would leak the
          // backend shell after the UI tab is gone.
          transport.preserve?.()
        } else {
          transport.destroy?.()
        }
      }
      for (const panePtyBinding of panePtyBindings.values()) {
        panePtyBinding.dispose()
      }
      panePtyBindings.clear()
      paneTransports.clear()
      pendingWrites.clear()
      manager.destroy()
      managerRef.current = null
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, systemPrefersDark])
}
