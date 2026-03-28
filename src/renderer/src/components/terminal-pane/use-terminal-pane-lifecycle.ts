import { useEffect, useRef } from 'react'
import type { IDisposable } from '@xterm/xterm'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { createFilePathLinkProvider, handleOscLink } from './terminal-link-handlers'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import type { GlobalSettings, TerminalLayoutSnapshot } from '../../../../shared/types'
import { buildFontFamily, replayTerminalLayout } from './layout-serialization'
import { applyExpandedLayoutTo, restoreExpandedLayoutFrom } from './expand-collapse'
import { applyTerminalAppearance } from './terminal-appearance'
import { connectPanePty } from './pty-connection'
import type { PtyTransport } from './pty-transport'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'

type UseTerminalPaneLifecycleDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
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
  clearTabPtyId: (tabId: string, ptyId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  markWorktreeUnreadFromBell: (worktreeId: string) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setExpandedPane: (paneId: number | null) => void
  syncExpandedLayout: () => void
  persistLayoutSnapshot: () => void
}

export function useTerminalPaneLifecycle({
  tabId,
  worktreeId,
  cwd,
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
  clearTabPtyId,
  updateTabTitle,
  updateTabPtyId,
  markWorktreeUnreadFromBell,
  setTabPaneExpanded,
  setTabCanExpandPane,
  setExpandedPane,
  syncExpandedLayout,
  persistLayoutSnapshot
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
      paneTransportsRef,
      pendingWritesRef,
      isActiveRef,
      onPtyExitRef,
      clearTabPtyId,
      updateTabTitle,
      updateTabPtyId,
      markWorktreeUnreadFromBell
    }

    const manager = new PaneManager(container, {
      onPaneCreated: (pane) => {
        const linkProviderDisposable = pane.terminal.registerLinkProvider(
          createFilePathLinkProvider(pane.id, linkDeps)
        )
        linkProviderDisposablesRef.current.set(pane.id, linkProviderDisposable)
        pane.terminal.options.linkHandler = {
          allowNonHttpProtocols: true,
          activate: (event, text) => handleOscLink(text, event as MouseEvent | undefined)
        }
        applyAppearance(manager)
        connectPanePty(pane, manager, ptyDeps)
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
          transport.destroy?.()
          paneTransportsRef.current.delete(paneId)
        }
        paneFontSizesRef.current.delete(paneId)
        pendingWritesRef.current.delete(paneId)
      },
      onActivePaneChange: () => {
        if (shouldPersistLayout) {
          persistLayoutSnapshot()
        }
      },
      onLayoutChanged: () => {
        syncExpandedLayout()
        syncCanExpandState()
        queueResizeAll(false)
        if (shouldPersistLayout) {
          persistLayoutSnapshot()
        }
      },
      terminalOptions: () => {
        const currentSettings = settingsRef.current
        return {
          fontSize: currentSettings?.terminalFontSize ?? 14,
          fontFamily: buildFontFamily(currentSettings?.terminalFontFamily ?? 'SF Mono'),
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

    return () => {
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
