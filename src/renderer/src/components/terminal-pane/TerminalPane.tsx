import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { useAppStore } from '../../store'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  normalizeColor,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import TerminalSearch from '@/components/TerminalSearch'
import type { PtyTransport } from './pty-transport'
import { EMPTY_LAYOUT, serializeTerminalLayout } from './layout-serialization'
import { createExpandCollapseActions } from './expand-collapse'
import { useTerminalKeyboardShortcuts, useTerminalFontZoom } from './keyboard-handlers'
import TerminalContextMenu from './TerminalContextMenu'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { useTerminalPaneLifecycle } from './use-terminal-pane-lifecycle'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'

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
  const paneFontSizesRef = useRef<Map<number, number>>(new Map())
  const expandedPaneIdRef = useRef<number | null>(null)
  const expandedStyleSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const paneTransportsRef = useRef<Map<number, PtyTransport>>(new Map())
  const pendingWritesRef = useRef<Map<number, string>>(new Map())
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

  const setTabPaneExpanded = useAppStore((store) => store.setTabPaneExpanded)
  const setTabCanExpandPane = useAppStore((store) => store.setTabCanExpandPane)
  const savedLayout = useAppStore((store) => store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const setTabLayout = useAppStore((store) => store.setTabLayout)
  const initialLayoutRef = useRef(savedLayout)
  const updateTabTitle = useAppStore((store) => store.updateTabTitle)
  const updateTabPtyId = useAppStore((store) => store.updateTabPtyId)
  const clearTabPtyId = useAppStore((store) => store.clearTabPtyId)
  const markWorktreeUnreadFromBell = useAppStore((store) => store.markWorktreeUnreadFromBell)
  const settings = useAppStore((store) => store.settings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onPtyExitRef = useRef(onPtyExit)
  onPtyExitRef.current = onPtyExit

  const systemPrefersDark = useSystemPrefersDark()

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

  useTerminalPaneLifecycle({
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
  })

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
    setSearchOpen
  })

  useTerminalPaneGlobalEffects({
    tabId,
    isActive,
    managerRef,
    containerRef,
    pendingWritesRef,
    paneTransportsRef,
    isActiveRef,
    toggleExpandPane
  })

  // Intercept paste events on the terminal to bypass Chromium's native
  // clipboard pipeline. Chromium holds NSPasteboard references during format
  // conversion, which can cause concurrent clipboard reads by CLI tools
  // (e.g. Codex checking for images) to fail intermittently. Reading via
  // Electron's clipboard module in the main process avoids this contention.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
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
      void window.api.ui
        .readClipboardText()
        .then((text) => {
          if (text) {
            pane.terminal.paste(text)
          }
        })
        .catch(() => {
          /* ignore clipboard read failures */
        })
    }
    container.addEventListener('paste', onPaste, { capture: true })
    return () => container.removeEventListener('paste', onPaste, { capture: true })
  }, [isActive])

  const contextMenu = useTerminalPaneContextMenu({
    managerRef,
    toggleExpandPane
  })

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
        onContextMenuCapture={contextMenu.onContextMenuCapture}
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
      />
    </>
  )
}
