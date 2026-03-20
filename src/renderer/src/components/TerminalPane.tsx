import { useEffect, useRef, useState } from 'react'
import { Restty, getBuiltinTheme } from 'restty'
import type { CSSProperties } from 'react'
import {
  Clipboard,
  Copy,
  Eraser,
  Maximize2,
  Minimize2,
  PanelBottomOpen,
  PanelRightOpen,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../shared/types'
import { useAppStore } from '../store'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  buildTerminalFontMatchers,
  colorToCss,
  getCursorStyleSequence,
  normalizeColor,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'

type PtyTransport = {
  connect: (options: {
    url: string
    cols?: number
    rows?: number
    callbacks: {
      onConnect?: () => void
      onDisconnect?: () => void
      onData?: (data: string) => void
      onStatus?: (shell: string) => void
      onError?: (message: string, errors?: string[]) => void
      onExit?: (code: number) => void
    }
  }) => void | Promise<void>
  disconnect: () => void
  sendInput: (data: string) => boolean
  resize: (
    cols: number,
    rows: number,
    meta?: { widthPx?: number; heightPx?: number; cellW?: number; cellH?: number }
  ) => boolean
  isConnected: () => boolean
  destroy?: () => void | Promise<void>
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'
const EMPTY_LAYOUT: TerminalLayoutSnapshot = {
  root: null,
  activeLeafId: null,
  expandedLeafId: null
}

const OSC_TITLE_RE = /\x1b\]([012]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g

function extractLastOscTitle(data: string): string | null {
  let last: string | null = null
  let m: RegExpExecArray | null
  OSC_TITLE_RE.lastIndex = 0
  while ((m = OSC_TITLE_RE.exec(data)) !== null) {
    last = m[2]
  }
  return last
}

function createIpcPtyTransport(
  cwd?: string,
  onPtyExit?: (ptyId: string) => void,
  onTitleChange?: (title: string) => void,
  onPtySpawn?: (ptyId: string) => void,
  onBell?: () => void
): PtyTransport {
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  let pendingEscape = false
  let inOsc = false
  let pendingOscEscape = false
  let storedCallbacks: {
    onConnect?: () => void
    onDisconnect?: () => void
    onData?: (data: string) => void
    onStatus?: (shell: string) => void
    onError?: (message: string, errors?: string[]) => void
    onExit?: (code: number) => void
  } = {}
  let unsubData: (() => void) | null = null
  let unsubExit: (() => void) | null = null

  function cleanupListeners(): void {
    unsubData?.()
    unsubExit?.()
    unsubData = null
    unsubExit = null
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks

      try {
        const result = await window.api.pty.spawn({
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd
        })

        // If destroyed while spawn was in flight, kill the new pty and bail
        if (destroyed) {
          window.api.pty.kill(result.id)
          return
        }

        ptyId = result.id
        connected = true
        onPtySpawn?.(result.id)

        // Clean up any stale listeners before registering new ones
        cleanupListeners()

        unsubData = window.api.pty.onData((payload) => {
          if (payload.id === ptyId) {
            storedCallbacks.onData?.(payload.data)
            if (onTitleChange) {
              const title = extractLastOscTitle(payload.data)
              if (title !== null) onTitleChange(title)
            }
            if (onBell && chunkContainsBell(payload.data)) {
              onBell()
            }
          }
        })

        unsubExit = window.api.pty.onExit((payload) => {
          if (payload.id === ptyId) {
            connected = false
            const exitedPtyId = payload.id
            storedCallbacks.onExit?.(payload.code)
            storedCallbacks.onDisconnect?.()
            ptyId = null
            onPtyExit?.(exitedPtyId)
          }
        })

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        storedCallbacks.onError?.(msg)
      }
    },

    disconnect() {
      if (ptyId) {
        window.api.pty.kill(ptyId)
        connected = false
        ptyId = null
        cleanupListeners()
        storedCallbacks.onDisconnect?.()
      }
    },

    sendInput(data: string): boolean {
      if (!connected || !ptyId) return false
      window.api.pty.write(ptyId, data)
      return true
    },

    resize(cols: number, rows: number): boolean {
      if (!connected || !ptyId) return false
      window.api.pty.resize(ptyId, cols, rows)
      return true
    },

    isConnected() {
      return connected
    },

    destroy() {
      destroyed = true
      this.disconnect()
    }
  }

  function chunkContainsBell(data: string): boolean {
    for (let i = 0; i < data.length; i += 1) {
      const char = data[i]

      if (inOsc) {
        if (pendingOscEscape) {
          pendingOscEscape = char === '\x1b'
          if (char === '\\') {
            inOsc = false
            pendingOscEscape = false
          }
          continue
        }

        if (char === '\x07') {
          inOsc = false
          continue
        }

        pendingOscEscape = char === '\x1b'
        continue
      }

      if (pendingEscape) {
        pendingEscape = false
        if (char === ']') {
          inOsc = true
          pendingOscEscape = false
        } else if (char === '\x1b') {
          pendingEscape = true
        }
        continue
      }

      if (char === '\x1b') {
        pendingEscape = true
        continue
      }

      if (char === '\x07') return true
    }

    return false
  }
}

function paneLeafId(paneId: number): string {
  return `pane:${paneId}`
}

function buildTerminalFontSources(fontFamily: string) {
  return [
    {
      type: 'local' as const,
      label: fontFamily || 'Preferred terminal font',
      matchers: buildTerminalFontMatchers(fontFamily),
      required: true
    },
    {
      type: 'local' as const,
      label: 'Menlo',
      matchers: ['menlo', 'menlo regular']
    },
    {
      type: 'local' as const,
      label: 'Monospace fallback',
      matchers: ['dejavu sans mono', 'liberation mono', 'ubuntu mono', 'monospace']
    }
  ]
}

function getLayoutChildNodes(split: HTMLElement): HTMLElement[] {
  return Array.from(split.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
}

function serializePaneTree(node: HTMLElement | null): TerminalPaneLayoutNode | null {
  if (!node) return null

  if (node.classList.contains('pane')) {
    const paneId = Number(node.dataset.paneId ?? '')
    if (!Number.isFinite(paneId)) return null
    return { type: 'leaf', leafId: paneLeafId(paneId) }
  }

  if (!node.classList.contains('pane-split')) return null
  const [first, second] = getLayoutChildNodes(node)
  const firstNode = serializePaneTree(first ?? null)
  const secondNode = serializePaneTree(second ?? null)
  if (!firstNode || !secondNode) return null

  return {
    type: 'split',
    direction: node.classList.contains('is-horizontal') ? 'horizontal' : 'vertical',
    first: firstNode,
    second: secondNode
  }
}

function serializeTerminalLayout(
  root: HTMLDivElement | null,
  activePaneId: number | null,
  expandedPaneId: number | null
): TerminalLayoutSnapshot {
  const rootNode = serializePaneTree(
    root?.firstElementChild instanceof HTMLElement ? root.firstElementChild : null
  )
  return {
    root: rootNode,
    activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
    expandedLeafId: expandedPaneId === null ? null : paneLeafId(expandedPaneId)
  }
}

function replayTerminalLayout(
  restty: Restty,
  snapshot: TerminalLayoutSnapshot | null | undefined,
  focusInitialPane: boolean
): Map<string, number> {
  const paneByLeafId = new Map<string, number>()

  const initialPane = restty.createInitialPane({ focus: focusInitialPane })
  if (!snapshot?.root) {
    paneByLeafId.set(paneLeafId(initialPane.id), initialPane.id)
    return paneByLeafId
  }

  const restoreNode = (node: TerminalPaneLayoutNode, paneId: number): void => {
    if (node.type === 'leaf') {
      paneByLeafId.set(node.leafId, paneId)
      return
    }

    const createdPane = restty.splitPane(paneId, node.direction as TerminalPaneSplitDirection)
    if (!createdPane) {
      collectLeafIds(node, paneByLeafId, paneId)
      return
    }

    restoreNode(node.first, paneId)
    restoreNode(node.second, createdPane.id)
  }

  restoreNode(snapshot.root, initialPane.id)
  return paneByLeafId
}

function collectLeafIds(
  node: TerminalPaneLayoutNode,
  paneByLeafId: Map<string, number>,
  paneId: number
): void {
  if (node.type === 'leaf') {
    paneByLeafId.set(node.leafId, paneId)
    return
  }
  collectLeafIds(node.first, paneByLeafId, paneId)
  collectLeafIds(node.second, paneByLeafId, paneId)
}

interface TerminalPaneProps {
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
  const resttyRef = useRef<Restty | null>(null)
  const contextPaneIdRef = useRef<number | null>(null)
  const wasActiveRef = useRef(false)
  const expandedPaneIdRef = useRef<number | null>(null)
  const expandedStyleSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false)
  const [terminalMenuPoint, setTerminalMenuPoint] = useState({ x: 0, y: 0 })
  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  const setTabPaneExpanded = useAppStore((s) => s.setTabPaneExpanded)
  const setTabCanExpandPane = useAppStore((s) => s.setTabCanExpandPane)
  const savedLayout = useAppStore((s) => s.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const setTabLayout = useAppStore((s) => s.setTabLayout)
  const initialLayoutRef = useRef(savedLayout)

  const persistLayoutSnapshot = (): void => {
    const restty = resttyRef.current
    const container = containerRef.current
    if (!restty || !container) return
    const activePaneId = restty.getActivePane()?.id ?? restty.getPanes()[0]?.id ?? null
    setTabLayout(tabId, serializeTerminalLayout(container, activePaneId, expandedPaneIdRef.current))
  }

  const setExpandedPane = (paneId: number | null): void => {
    expandedPaneIdRef.current = paneId
    setExpandedPaneId(paneId)
    setTabPaneExpanded(tabId, paneId !== null)
    persistLayoutSnapshot()
  }

  const rememberPaneStyle = (
    snapshots: Map<HTMLElement, { display: string; flex: string }>,
    el: HTMLElement
  ): void => {
    if (snapshots.has(el)) return
    snapshots.set(el, { display: el.style.display, flex: el.style.flex })
  }

  const restoreExpandedLayout = (): void => {
    const snapshots = expandedStyleSnapshotRef.current
    for (const [el, prev] of snapshots.entries()) {
      el.style.display = prev.display
      el.style.flex = prev.flex
    }
    snapshots.clear()
  }

  const applyExpandedLayout = (paneId: number): boolean => {
    const restty = resttyRef.current
    const root = containerRef.current
    if (!restty || !root) return false

    const panes = restty.getPanes()
    if (panes.length <= 1) return false
    const targetPane = panes.find((pane) => pane.id === paneId)
    if (!targetPane) return false

    restoreExpandedLayout()
    const snapshots = expandedStyleSnapshotRef.current
    let current: HTMLElement | null = targetPane.container
    while (current && current !== root) {
      const parent = current.parentElement
      if (!parent) break
      for (const child of Array.from(parent.children)) {
        if (!(child instanceof HTMLElement)) continue
        rememberPaneStyle(snapshots, child)
        if (child === current) {
          child.style.display = ''
          child.style.flex = '1 1 auto'
        } else {
          child.style.display = 'none'
        }
      }
      current = parent
    }
    return true
  }

  const refreshPaneSizes = (focusActive: boolean): void => {
    requestAnimationFrame(() => {
      const restty = resttyRef.current
      if (!restty) return
      const panes = restty.getPanes()
      for (const p of panes) {
        p.app.updateSize(true)
      }
      if (focusActive) {
        const active = restty.getActivePane() ?? panes[0]
        active?.canvas.focus({ preventScroll: true })
      }
    })
  }

  const syncExpandedLayout = (): void => {
    const paneId = expandedPaneIdRef.current
    if (paneId === null) {
      restoreExpandedLayout()
      return
    }

    const restty = resttyRef.current
    if (!restty) return
    const panes = restty.getPanes()
    if (panes.length <= 1 || !panes.some((pane) => pane.id === paneId)) {
      setExpandedPane(null)
      restoreExpandedLayout()
      return
    }
    applyExpandedLayout(paneId)
  }

  const syncCanExpandState = (): void => {
    const paneCount = resttyRef.current?.getPanes().length ?? 1
    setTabCanExpandPane(tabId, paneCount > 1)
  }

  const toggleExpandPane = (paneId: number): void => {
    const restty = resttyRef.current
    if (!restty) return
    const panes = restty.getPanes()
    if (panes.length <= 1) return

    const isAlreadyExpanded = expandedPaneIdRef.current === paneId
    if (isAlreadyExpanded) {
      setExpandedPane(null)
      restoreExpandedLayout()
      refreshPaneSizes(true)
      persistLayoutSnapshot()
      return
    }

    setExpandedPane(paneId)
    if (!applyExpandedLayout(paneId)) {
      setExpandedPane(null)
      restoreExpandedLayout()
      persistLayoutSnapshot()
      return
    }
    restty.setActivePane(paneId, { focus: true })
    refreshPaneSizes(true)
    persistLayoutSnapshot()
  }

  useEffect(() => {
    const closeMenu = (): void => setTerminalMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  const updateTabTitle = useAppStore((s) => s.updateTabTitle)
  const updateTabPtyId = useAppStore((s) => s.updateTabPtyId)
  const clearTabPtyId = useAppStore((s) => s.clearTabPtyId)
  const markWorktreeUnreadFromBell = useAppStore((s) => s.markWorktreeUnreadFromBell)
  const settings = useAppStore((s) => s.settings)
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
  )
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Use a ref so the Restty closure always calls the latest onPtyExit
  const onPtyExitRef = useRef(onPtyExit)
  onPtyExitRef.current = onPtyExit

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent): void => {
      setSystemPrefersDark(event.matches)
    }
    setSystemPrefersDark(media.matches)
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  const applyTerminalAppearance = (restty: Restty): void => {
    const currentSettings = settingsRef.current
    if (!currentSettings) return

    const appearance = resolveEffectiveTerminalAppearance(currentSettings, systemPrefersDark)
    const paneStyles = resolvePaneStyleOptions(currentSettings)
    const cursorSequence = getCursorStyleSequence(
      currentSettings.terminalCursorStyle,
      currentSettings.terminalCursorBlink
    )
    const theme = appearance.theme ?? getBuiltinTheme(appearance.themeName)
    const paneBackground = colorToCss(theme?.colors.background, '#000000')
    for (const pane of restty.getPanes()) {
      if (theme) {
        pane.app.applyTheme(theme, appearance.themeName)
      }
      pane.app.setFontSize(currentSettings.terminalFontSize)
      pane.app.sendInput(cursorSequence, 'pty')
    }

    restty.setPaneStyleOptions({
      splitBackground: paneBackground,
      paneBackground,
      inactivePaneOpacity: paneStyles.inactivePaneOpacity,
      activePaneOpacity: paneStyles.activePaneOpacity,
      opacityTransitionMs: paneStyles.opacityTransitionMs,
      dividerThicknessPx: paneStyles.dividerThicknessPx
    })
  }

  // Initialize Restty instance once
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let resizeRaf: number | null = null

    const queueResizeAll = (focusActive: boolean): void => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        const restty = resttyRef.current
        if (!restty) return
        const panes = restty.getPanes()
        for (const p of panes) {
          p.app.updateSize(true)
        }
        if (focusActive) {
          const active = restty.getActivePane() ?? panes[0]
          active?.canvas.focus({ preventScroll: true })
        }
      })
    }

    const onTitleChange = (title: string): void => {
      updateTabTitle(tabId, title)
    }

    const onPtySpawn = (ptyId: string): void => updateTabPtyId(tabId, ptyId)
    const onBell = (): void => markWorktreeUnreadFromBell(worktreeId)

    let shouldPersistLayout = false

    const restty = new Restty({
      root: container,
      createInitialPane: false,
      autoInit: false,
      shortcuts: { enabled: false },
      defaultContextMenu: false,
      appOptions: ({ id }) => {
        const currentSettings = settingsRef.current
        const onExit = (ptyId: string): void => {
          // Schedule close via parent
          const panes = restty.getPanes()
          if (panes.length <= 1) {
            clearTabPtyId(tabId, ptyId)
            onPtyExitRef.current(ptyId)
            return
          }
          restty.closePane(id)
        }
        return {
          renderer: 'auto',
          fontSize: currentSettings?.terminalFontSize ?? 14,
          fontSizeMode: 'em',
          fontHinting: true,
          fontHintTarget: 'light',
          alphaBlending: 'linear-corrected',
          maxScrollbackBytes: currentSettings?.terminalScrollbackBytes ?? 10_000_000,
          ptyTransport: createIpcPtyTransport(
            cwd,
            onExit,
            onTitleChange,
            onPtySpawn,
            onBell
          ) as never,
          fontSources: buildTerminalFontSources(currentSettings?.terminalFontFamily ?? 'SF Mono')
        }
      },
      onPaneCreated: async (pane) => {
        await pane.app.init()
        applyTerminalAppearance(restty)
        pane.app.updateSize(true)
        pane.app.connectPty('')
        pane.canvas.focus({ preventScroll: true })
        queueResizeAll(true)
      },
      onPaneClosed: () => {},
      onActivePaneChange: () => {
        if (shouldPersistLayout) persistLayoutSnapshot()
      },
      onLayoutChanged: () => {
        syncExpandedLayout()
        syncCanExpandState()
        queueResizeAll(false)
        if (shouldPersistLayout) persistLayoutSnapshot()
      }
    })

    resttyRef.current = restty
    const restoredPaneByLeafId = replayTerminalLayout(restty, initialLayoutRef.current, isActive)
    const restoredActivePaneId =
      (initialLayoutRef.current.activeLeafId
        ? restoredPaneByLeafId.get(initialLayoutRef.current.activeLeafId)
        : null) ??
      restty.getActivePane()?.id ??
      restty.getPanes()[0]?.id ??
      null
    if (restoredActivePaneId !== null) {
      restty.setActivePane(restoredActivePaneId, { focus: isActive })
    }
    const restoredExpandedPaneId = initialLayoutRef.current.expandedLeafId
      ? (restoredPaneByLeafId.get(initialLayoutRef.current.expandedLeafId) ?? null)
      : null
    if (restoredExpandedPaneId !== null && restty.getPanes().length > 1) {
      setExpandedPane(restoredExpandedPaneId)
      applyExpandedLayout(restoredExpandedPaneId)
    } else {
      setExpandedPane(null)
    }
    shouldPersistLayout = true
    syncCanExpandState()
    applyTerminalAppearance(restty)
    queueResizeAll(isActive)
    persistLayoutSnapshot()

    return () => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      restoreExpandedLayout()
      restty.destroy()
      resttyRef.current = null
      setTabPaneExpanded(tabId, false)
      setTabCanExpandPane(tabId, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, cwd])

  useEffect(() => {
    const restty = resttyRef.current
    if (!restty || !settings) return
    applyTerminalAppearance(restty)
    void Promise.all(
      restty
        .getPanes()
        .map((pane) =>
          pane.app.setFontSources(buildTerminalFontSources(settings.terminalFontFamily))
        )
    )
  }, [settings, systemPrefersDark])

  // Handle focus and resize when tab becomes active
  useEffect(() => {
    const restty = resttyRef.current
    if (!restty) return

    if (isActive) {
      // Ensure size/focus is correct both on initial mount and tab activation.
      requestAnimationFrame(() => {
        const panes = restty.getPanes()
        for (const p of panes) {
          p.app.updateSize(true)
        }
        const active = restty.getActivePane() ?? panes[0]
        if (active) {
          active.canvas.focus({ preventScroll: true })
        }
      })
    }
    wasActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    const onToggleExpand = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (!detail?.tabId || detail.tabId !== tabId) return
      const restty = resttyRef.current
      if (!restty) return
      const panes = restty.getPanes()
      if (panes.length < 2) return
      const pane = restty.getActivePane() ?? panes[0]
      if (!pane) return
      toggleExpandPane(pane.id)
    }

    window.addEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    return () => window.removeEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
  }, [tabId])

  // ResizeObserver to keep terminal sized to container
  useEffect(() => {
    if (!isActive) return

    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver(() => {
      const restty = resttyRef.current
      if (!restty) return
      const panes = restty.getPanes()
      for (const p of panes) {
        p.app.updateSize(true)
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [isActive])

  // Terminal pane shortcuts handled at window capture phase so they remain
  // reliable even when focus is inside the canvas/IME internals.
  useEffect(() => {
    if (!isActive) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (!e.metaKey || e.altKey || e.ctrlKey) return

      const restty = resttyRef.current
      if (!restty) return

      // Cmd+K clears active pane screen + scrollback.
      if (!e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        const activePane = restty.activePane?.()
        if (activePane) {
          activePane.clearScreen()
          return
        }
        const pane = restty.getActivePane() ?? restty.getPanes()[0]
        pane?.app.clearScreen()
        return
      }

      // Cmd+[ / Cmd+] cycles active split pane focus.
      if (!e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        const panes = restty.getPanes()
        if (panes.length < 2) return
        e.preventDefault()
        e.stopPropagation()

        const activeId = restty.getActivePane()?.id ?? panes[0].id
        const currentIdx = panes.findIndex((p) => p.id === activeId)
        if (currentIdx === -1) return

        const dir = e.code === 'BracketRight' ? 1 : -1
        const nextPane = panes[(currentIdx + dir + panes.length) % panes.length]
        restty.setActivePane(nextPane.id, { focus: true })
        return
      }

      // Cmd+Shift+Enter expands/collapses the active pane to full terminal area.
      if (e.shiftKey && e.key === 'Enter' && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
        const panes = restty.getPanes()
        if (panes.length < 2) return
        e.preventDefault()
        e.stopPropagation()
        const pane = restty.getActivePane() ?? panes[0]
        if (!pane) return
        toggleExpandPane(pane.id)
        return
      }

      // Cmd+W closes only the active split pane and prevents the tab-level
      // handler from closing the entire terminal tab.
      if (!e.shiftKey && e.key.toLowerCase() === 'w') {
        const panes = restty.getPanes()
        if (panes.length < 2) return
        e.preventDefault()
        e.stopPropagation()
        const pane = restty.getActivePane() ?? panes[0]
        if (!pane) return
        restty.closePane(pane.id)
        return
      }

      // Cmd+D / Cmd+Shift+D split the active pane in the focused tab only.
      if (e.key.toLowerCase() === 'd') {
        e.preventDefault()
        e.stopPropagation()
        const pane = restty.getActivePane() ?? restty.getPanes()[0]
        if (!pane) return
        restty.splitPane(pane.id, e.shiftKey ? 'horizontal' : 'vertical')
      }
    }

    // Ctrl+Backspace → send \x17 (backward-kill-word) to PTY.
    // Most terminal emulators map this shortcut but xterm.js/Restty does not
    // by default, so we intercept at the capture phase and forward manually.
    const onCtrlBackspace = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (e.key !== 'Backspace') return

      const restty = resttyRef.current
      if (!restty) return

      e.preventDefault()
      e.stopPropagation()
      const pane = restty.getActivePane() ?? restty.getPanes()[0]
      pane?.app.sendKeyInput('\x17')
    }

    // Shift+Enter → insert a literal newline into the shell command line.
    // Sends Ctrl+V (\x16, quoted-insert) followed by LF (\x0a) so that
    // both bash (readline) and zsh (zle) insert a newline character instead
    // of executing the command.
    const onShiftEnter = (e: KeyboardEvent): void => {
      if (!e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return
      if (e.key !== 'Enter') return

      const restty = resttyRef.current
      if (!restty) return

      e.preventDefault()
      e.stopPropagation()
      const pane = restty.getActivePane() ?? restty.getPanes()[0]
      pane?.app.sendKeyInput('\x16\x0a')
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keydown', onCtrlBackspace, { capture: true })
    window.addEventListener('keydown', onShiftEnter, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keydown', onCtrlBackspace, { capture: true })
      window.removeEventListener('keydown', onShiftEnter, { capture: true })
    }
  }, [isActive])

  const resolveMenuPane = () => {
    const restty = resttyRef.current
    if (!restty) return null
    const panes = restty.getPanes()

    if (contextPaneIdRef.current !== null) {
      const clickedPane = panes.find((p) => p.id === contextPaneIdRef.current) ?? null
      if (clickedPane) return clickedPane
    }
    return restty.getActivePane() ?? panes[0] ?? null
  }

  const handleCopy = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) return
    await pane.app.copySelectionToClipboard()
  }

  const handlePaste = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) return
    await pane.app.pasteFromClipboard()
  }

  const handleSplitRight = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    resttyRef.current?.splitPane(pane.id, 'vertical')
  }

  const handleSplitDown = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    resttyRef.current?.splitPane(pane.id, 'horizontal')
  }

  const handleClosePane = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    const panes = resttyRef.current?.getPanes() ?? []
    if (panes.length <= 1) return
    resttyRef.current?.closePane(pane.id)
  }

  const handleClearScreen = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    pane.app.clearScreen()
  }

  const handleToggleExpand = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    toggleExpandPane(pane.id)
  }

  const paneCount = resttyRef.current?.getPanes().length ?? 1
  const canClosePane = paneCount > 1
  const canExpandPane = paneCount > 1
  const menuPaneId = resolveMenuPane()?.id ?? null
  const menuPaneIsExpanded = menuPaneId !== null && menuPaneId === expandedPaneId
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

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0 min-h-0 min-w-0"
        style={terminalContainerStyle}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))

          const restty = resttyRef.current
          if (!restty) {
            contextPaneIdRef.current = null
            return
          }

          const target = event.target
          if (!(target instanceof Node)) {
            contextPaneIdRef.current = null
            return
          }
          const clickedPane =
            restty.getPanes().find((pane) => pane.container.contains(target)) ?? null
          contextPaneIdRef.current = clickedPane?.id ?? null

          const bounds = event.currentTarget.getBoundingClientRect()
          setTerminalMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
          setTerminalMenuOpen(true)
        }}
      />
      <DropdownMenu open={terminalMenuOpen} onOpenChange={setTerminalMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: terminalMenuPoint.x, top: terminalMenuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" sideOffset={0} align="start">
          <DropdownMenuItem onSelect={() => void handleCopy()}>
            <Copy />
            Copy
            <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handlePaste()}>
            <Clipboard />
            Paste
            <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleSplitRight}>
            <PanelRightOpen />
            Split Right
            <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleSplitDown}>
            <PanelBottomOpen />
            Split Down
            <DropdownMenuShortcut>⌘⇧D</DropdownMenuShortcut>
          </DropdownMenuItem>
          {canExpandPane && (
            <DropdownMenuItem onSelect={handleToggleExpand}>
              {menuPaneIsExpanded ? <Minimize2 /> : <Maximize2 />}
              {menuPaneIsExpanded ? 'Collapse Pane' : 'Expand Pane'}
              <DropdownMenuShortcut>⌘⇧↩</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            disabled={!canClosePane}
            onSelect={handleClosePane}
          >
            <X />
            Close Pane
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleClearScreen}>
            <Eraser />
            Clear Screen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
