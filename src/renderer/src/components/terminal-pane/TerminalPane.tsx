import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { useAppStore } from '../../store'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  normalizeColor,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import TerminalSearch from '@/components/TerminalSearch'
import type { PtyTransport } from './pty-transport'
import {
  EMPTY_LAYOUT,
  buildFontFamily,
  serializeTerminalLayout,
  replayTerminalLayout
} from './layout-serialization'
import {
  createExpandCollapseActions,
  restoreExpandedLayoutFrom,
  applyExpandedLayoutTo
} from './expand-collapse'
import { useTerminalKeyboardShortcuts, useTerminalFontZoom } from './keyboard-handlers'
import { applyTerminalAppearance } from './terminal-appearance'
import { connectPanePty } from './pty-connection'
import TerminalContextMenu from './TerminalContextMenu'

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

type TerminalPaneProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  onPtyExit: (ptyId: string) => void
}

export default function TerminalPane({
  tabId,
  worktreeId,
  cwd,
  isActive,
  onPtyExit
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const managerRef = useRef<PaneManager | null>(null)
  const contextPaneIdRef = useRef<number | null>(null)
  const wasActiveRef = useRef(false)
  const paneFontSizesRef = useRef<Map<number, number>>(new Map())
  const expandedPaneIdRef = useRef<number | null>(null)
  const expandedStyleSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const paneTransportsRef = useRef<Map<number, PtyTransport>>(new Map())
  const pendingWritesRef = useRef<Map<number, string>>(new Map())
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false)
  const [terminalMenuPoint, setTerminalMenuPoint] = useState({ x: 0, y: 0 })
  const menuOpenedAtRef = useRef(0)
  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const setTabPaneExpanded = useAppStore((s) => s.setTabPaneExpanded)
  const setTabCanExpandPane = useAppStore((s) => s.setTabCanExpandPane)
  const savedLayout = useAppStore((s) => s.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const setTabLayout = useAppStore((s) => s.setTabLayout)
  const initialLayoutRef = useRef(savedLayout)
  const updateTabTitle = useAppStore((s) => s.updateTabTitle)
  const updateTabPtyId = useAppStore((s) => s.updateTabPtyId)
  const clearTabPtyId = useAppStore((s) => s.clearTabPtyId)
  const markWorktreeUnreadFromBell = useAppStore((s) => s.markWorktreeUnreadFromBell)
  const settings = useAppStore((s) => s.settings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onPtyExitRef = useRef(onPtyExit)
  onPtyExitRef.current = onPtyExit

  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
  )

  const persistLayoutSnapshot = (): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      return
    }
    const activePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    setTabLayout(tabId, serializeTerminalLayout(container, activePaneId, expandedPaneIdRef.current))
  }

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

  const syncCanExpandState = (): void => {
    const paneCount = managerRef.current?.getPanes().length ?? 1
    setTabCanExpandPane(tabId, paneCount > 1)
  }

  const doApplyAppearance = (manager: PaneManager): void => {
    const s = settingsRef.current
    if (!s) {
      return
    }
    applyTerminalAppearance(
      manager,
      s,
      systemPrefersDark,
      paneFontSizesRef.current,
      paneTransportsRef.current
    )
  }

  useEffect(() => {
    const closeMenu = (): void => {
      if (Date.now() - menuOpenedAtRef.current < 100) {
        return
      }
      setTerminalMenuOpen(false)
    }
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent): void => setSystemPrefersDark(event.matches)
    setSystemPrefersDark(media.matches)
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  // Initialize PaneManager instance once
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    let resizeRaf: number | null = null

    const queueResizeAll = (focusActive: boolean): void => {
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf)
      }
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        const m = managerRef.current
        if (!m) {
          return
        }
        const panes = m.getPanes()
        for (const p of panes) {
          try {
            p.fitAddon.fit()
          } catch {
            /* ignore */
          }
        }
        if (focusActive) {
          const active = m.getActivePane() ?? panes[0]
          active?.terminal.focus()
        }
      })
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
        doApplyAppearance(manager)
        connectPanePty(pane, manager, ptyDeps)
        queueResizeAll(true)
      },
      onPaneClosed: (paneId) => {
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
        const cs = settingsRef.current
        return {
          fontSize: cs?.terminalFontSize ?? 14,
          fontFamily: buildFontFamily(cs?.terminalFontFamily ?? 'SF Mono'),
          scrollback: Math.min(
            50_000,
            Math.max(1000, Math.round((cs?.terminalScrollbackBytes ?? 10_000_000) / 200))
          ),
          cursorStyle: cs?.terminalCursorStyle ?? 'bar',
          cursorBlink: cs?.terminalCursorBlink ?? true
        }
      },
      onLinkClick: (url) => {
        window.api.shell.openExternal(url)
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
    doApplyAppearance(manager)
    queueResizeAll(isActive)
    persistLayoutSnapshot()

    return () => {
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf)
      }
      restoreExpandedLayoutFrom(expandedStyleSnapshotRef.current)
      for (const transport of paneTransportsRef.current.values()) {
        transport.destroy?.()
      }
      paneTransportsRef.current.clear()
      pendingWritesRef.current.clear()
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
    doApplyAppearance(manager)
    const fontFamily = buildFontFamily(settings.terminalFontFamily)
    for (const pane of manager.getPanes()) {
      pane.terminal.options.fontFamily = fontFamily
      try {
        pane.fitAddon.fit()
      } catch {
        /* ignore */
      }
    }
  }, [settings, systemPrefersDark])

  useTerminalFontZoom({ isActive, managerRef, paneFontSizesRef, settingsRef })

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    if (isActive) {
      manager.resumeRendering()
      for (const [paneId, buf] of pendingWritesRef.current.entries()) {
        if (buf.length > 0) {
          const pane = manager.getPanes().find((p) => p.id === paneId)
          if (pane) {
            pane.terminal.write(buf)
          }
          pendingWritesRef.current.set(paneId, '')
        }
      }
      requestAnimationFrame(() => {
        const panes = manager.getPanes()
        for (const p of panes) {
          try {
            p.fitAddon.fit()
          } catch {
            /* ignore */
          }
        }
        const active = manager.getActivePane() ?? panes[0]
        if (active) {
          active.terminal.focus()
        }
      })
    } else if (wasActiveRef.current) {
      manager.suspendRendering()
    }
    wasActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    const onToggleExpand = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length < 2) {
        return
      }
      const pane = manager.getActivePane() ?? panes[0]
      if (!pane) {
        return
      }
      toggleExpandPane(pane.id)
    }
    window.addEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    return () => window.removeEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
  }, [tabId])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
    const ro = new ResizeObserver(() => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      for (const p of manager.getPanes()) {
        try {
          p.fitAddon.fit()
        } catch {
          /* ignore */
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [isActive])

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
    setSearchOpen
  })

  useEffect(() => {
    if (!isActive) {
      return
    }
    const shellEscape = (p: string): string => {
      if (/^[a-zA-Z0-9_./@:-]+$/.test(p)) {
        return p
      }
      return `'${p.replace(/'/g, "'\\''")}'`
    }
    return window.api.ui.onFileDrop(({ path: filePath }) => {
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
      transport.sendInput(shellEscape(filePath))
    })
  }, [isActive])

  const resolveMenuPane = () => {
    const manager = managerRef.current
    if (!manager) {
      return null
    }
    const panes = manager.getPanes()
    if (contextPaneIdRef.current !== null) {
      const clickedPane = panes.find((p) => p.id === contextPaneIdRef.current) ?? null
      if (clickedPane) {
        return clickedPane
      }
    }
    return manager.getActivePane() ?? panes[0] ?? null
  }

  const handleCopy = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const selection = pane.terminal.getSelection()
    if (selection) {
      await navigator.clipboard.writeText(selection)
    }
  }

  const handlePaste = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const text = await navigator.clipboard.readText()
    if (text) {
      paneTransportsRef.current.get(pane.id)?.sendInput(text)
    }
  }

  const handleSplitRight = (): void => {
    const p = resolveMenuPane()
    if (p) {
      managerRef.current?.splitPane(p.id, 'vertical')
    }
  }
  const handleSplitDown = (): void => {
    const p = resolveMenuPane()
    if (p) {
      managerRef.current?.splitPane(p.id, 'horizontal')
    }
  }
  const handleClosePane = (): void => {
    const p = resolveMenuPane()
    if (p && (managerRef.current?.getPanes().length ?? 0) > 1) {
      managerRef.current?.closePane(p.id)
    }
  }
  const handleClearScreen = (): void => {
    const p = resolveMenuPane()
    if (p) {
      p.terminal.clear()
    }
  }
  const handleToggleExpand = (): void => {
    const p = resolveMenuPane()
    if (p) {
      toggleExpandPane(p.id)
    }
  }

  const paneCount = managerRef.current?.getPanes().length ?? 1
  const menuPaneId = resolveMenuPane()?.id ?? null
  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null
  const terminalContainerStyle: CSSProperties = {
    display: isActive ? 'flex' : 'none',
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
        style={terminalContainerStyle}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          menuOpenedAtRef.current = Date.now()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          const manager = managerRef.current
          if (!manager) {
            contextPaneIdRef.current = null
            return
          }
          const target = event.target
          if (!(target instanceof Node)) {
            contextPaneIdRef.current = null
            return
          }
          const clickedPane =
            manager.getPanes().find((pane) => pane.container.contains(target)) ?? null
          contextPaneIdRef.current = clickedPane?.id ?? null
          const bounds = event.currentTarget.getBoundingClientRect()
          setTerminalMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
          setTerminalMenuOpen(true)
        }}
      />
      {activePane?.container &&
        createPortal(
          <TerminalSearch
            isOpen={searchOpen}
            onClose={() => setSearchOpen(false)}
            searchAddon={activePane.searchAddon ?? null}
          />,
          activePane.container
        )}
      <TerminalContextMenu
        open={terminalMenuOpen}
        onOpenChange={setTerminalMenuOpen}
        menuPoint={terminalMenuPoint}
        menuOpenedAtRef={menuOpenedAtRef}
        canClosePane={paneCount > 1}
        canExpandPane={paneCount > 1}
        menuPaneIsExpanded={menuPaneId !== null && menuPaneId === expandedPaneId}
        onCopy={() => void handleCopy()}
        onPaste={() => void handlePaste()}
        onSplitRight={handleSplitRight}
        onSplitDown={handleSplitDown}
        onClosePane={handleClosePane}
        onClearScreen={handleClearScreen}
        onToggleExpand={handleToggleExpand}
      />
    </>
  )
}
