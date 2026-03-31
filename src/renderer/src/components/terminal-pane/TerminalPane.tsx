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
import { shellEscapePath } from './pane-helpers'
import { EMPTY_LAYOUT, paneLeafId, serializeTerminalLayout } from './layout-serialization'
import { createExpandCollapseActions } from './expand-collapse'
import { useTerminalKeyboardShortcuts, useTerminalFontZoom } from './keyboard-handlers'
import TerminalContextMenu from './TerminalContextMenu'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { useTerminalPaneLifecycle } from './use-terminal-pane-lifecycle'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'

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
  const markWorktreeUnread = useAppStore((store) => store.markWorktreeUnread)
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
    const layout = serializeTerminalLayout(container, activePaneId, expandedPaneIdRef.current)
    // Preserve existing buffersByLeafId so layout-only persists (resize, split,
    // reorder) don't clobber previously captured scrollback.
    const existing = useAppStore.getState().terminalLayoutsByTabId[tabId]
    if (existing?.buffersByLeafId) {
      layout.buffersByLeafId = existing.buffersByLeafId
    }
    setTabLayout(tabId, layout)
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
    markWorktreeUnread,
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
      if (Object.keys(buffers).length === 0) {
        return
      }
      const activePaneId = manager.getActivePane()?.id ?? panes[0]?.id ?? null
      const layout = serializeTerminalLayout(container, activePaneId, expandedPaneIdRef.current)
      setTabLayout(tabId, { ...layout, buffersByLeafId: buffers })
    }
    shutdownBufferCaptures.add(captureBuffers)
    return () => {
      shutdownBufferCaptures.delete(captureBuffers)
    }
  }, [tabId, setTabLayout])

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
