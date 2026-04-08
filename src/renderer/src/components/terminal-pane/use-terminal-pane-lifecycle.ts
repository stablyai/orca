/* eslint-disable max-lines -- Why: terminal pane lifecycle wiring is intentionally co-located so PTY attach, theme sync, and runtime graph publication remain consistent for live terminals. */
import { useEffect, useRef } from 'react'
import type { IDisposable } from '@xterm/xterm'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { createFilePathLinkProvider, handleOscLink } from './terminal-link-handlers'
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
  pendingWritesRef: React.RefObject<Map<number, string>>
  isActiveRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
  clearTabPtyId: (tabId: string, ptyId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
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
  pendingWritesRef,
  isActiveRef,
  onPtyExitRef,
  onPtyErrorRef,
  clearTabPtyId,
  updateTabTitle,
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
      paneTransportsRef,
      pendingWritesRef,
      isActiveRef,
      onPtyExitRef,
      onPtyErrorRef,
      clearTabPtyId,
      updateTabTitle,
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

    const isMac = navigator.userAgent.includes('Mac')
    const openLinkHint = isMac ? '⌘+click to open' : 'Ctrl+click to open'

    const manager = new PaneManager(container, {
      onPaneCreated: (pane) => {
        const linkProviderDisposable = pane.terminal.registerLinkProvider(
          createFilePathLinkProvider(pane.id, linkDeps, pane.linkTooltip, openLinkHint)
        )
        linkProviderDisposablesRef.current.set(pane.id, linkProviderDisposable)
        pane.terminal.options.linkHandler = {
          allowNonHttpProtocols: true,
          activate: (event, text) => handleOscLink(text, event as MouseEvent | undefined),
          // Show bottom-left tooltip on hover for OSC 8 hyperlinks (e.g.
          // GitHub owner/repo#issue references emitted by CLI tools) — same
          // behaviour as the WebLinksAddon provides for plain-text URLs.
          hover: (_event, text) => {
            pane.linkTooltip.textContent = `${text} (${openLinkHint})`
            pane.linkTooltip.style.display = ''
          },
          leave: () => {
            pane.linkTooltip.style.display = 'none'
          }
        }
        applyAppearance(manager)
        connectPanePty(pane, manager, ptyDeps)
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
        if (transport) {
          const ptyId = transport.getPtyId()
          if (ptyId) {
            clearTabPtyId(tabId, ptyId)
          }
          transport.destroy?.()
          paneTransportsRef.current.delete(paneId)
        }
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
        void handleOscLink(url, event)
      }
    })

    managerRef.current = manager
    const restoredPaneByLeafId = replayTerminalLayout(manager, initialLayoutRef.current, isActive)

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
      for (const transport of paneTransports.values()) {
        transport.destroy?.()
      }
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
