/* oxlint-disable max-lines -- Why: rendering the drop-indicator prop on each
 * of three distinct tab components (terminal, browser, editor) adds 3 lines
 * to a file that was already ~398 code lines on main. The per-type render
 * branches share little beyond drag data, so consolidating them would cost
 * more clarity than the ~5 lines of bloat is worth. */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { FilePlus, FileText, Globe, Plus, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import type {
  BrowserTab as BrowserTabState,
  TerminalTab,
  TuiAgent,
  WorkspaceVisibleTabType
} from '../../../../shared/types'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { useAppStore } from '../../store'
import { buildStatusMap } from '../right-sidebar/status-display'
import type { OpenFile } from '../../store/slices/editor'
import SortableTab from './SortableTab'
import EditorFileTab from './EditorFileTab'
import BrowserTab, { getBrowserTabLabel } from './BrowserTab'
import { QuickLaunchAgentMenuItems } from './QuickLaunchButton'
import type { DropIndicator } from './drop-indicator'
import { reconcileTabOrder } from './reconcile-order'
import type { HoveredTabInsertion, TabDragItemData } from '../tab-group/useTabDragSplit'
import { resolveTabIndicatorEdges } from '../tab-group/tab-insertion'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import TabBarCreateEntry from './TabBarCreateEntry'
import { ShellIcon } from './shell-icons'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  type BuiltInWindowsTerminalShell,
  WINDOWS_GIT_BASH_SHELL
} from '../../../../shared/windows-terminal-shell'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TabCreateEntryArgs } from './tab-create-entry-action'
import { buildTabAgentLaunchOptions, orderTabLaunchAgents } from './tab-agent-launch-options'

const isWindows = navigator.userAgent.includes('Windows')
const NEW_TAB_MENU_TERMINAL_FOCUS_RETRY_MS = 50
const NEW_TAB_MENU_TERMINAL_FOCUS_TIMEOUT_MS = 5000
type GitStatusEntries = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree'][string]
const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntries = []
const EMPTY_AGENT_CMD_OVERRIDES: Partial<Record<TuiAgent, string>> = {}

type TabBarProps = {
  tabs: (TerminalTab & { unifiedTabId?: string })[]
  activeTabId: string | null
  groupId?: string
  worktreeId: string
  expandedPaneByTabId: Record<string, boolean>
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onNewTerminalTab: () => void
  /** On Windows, opens a new terminal with a specific shell instead of the default. */
  onNewTerminalWithShell?: (shell: string) => void
  onNewBrowserTab: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  terminalOnly?: boolean
  showAgentLaunchItems?: boolean
  onNewFileTab?: () => void
  onOpenFileTab?: () => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePaneExpand: (tabId: string) => void
  editorFiles?: (OpenFile & { tabId?: string })[]
  browserTabs?: (BrowserTabState & { tabId?: string })[]
  activeFileId?: string | null
  activeBrowserTabId?: string | null
  activeTabType?: WorkspaceVisibleTabType
  onActivateFile?: (fileId: string) => void
  onCloseFile?: (fileId: string) => void
  onActivateBrowserTab?: (tabId: string) => void
  onCloseBrowserTab?: (tabId: string) => void
  onDuplicateBrowserTab?: (tabId: string) => void
  onCloseAllFiles?: () => void
  onPinFile?: (fileId: string, tabId?: string) => void
  tabBarOrder?: string[]
  onCreateSplitGroup?: (
    direction: 'left' | 'right' | 'up' | 'down',
    sourceVisibleTabId?: string
  ) => void
  hoveredTabInsertion?: HoveredTabInsertion | null
}

type TabItem =
  | {
      type: 'terminal'
      id: string
      unifiedTabId: string
      data: TerminalTab & { unifiedTabId?: string }
    }
  | { type: 'editor'; id: string; unifiedTabId: string; data: OpenFile & { tabId?: string } }
  | {
      type: 'browser'
      id: string
      unifiedTabId: string
      data: BrowserTabState & { tabId?: string }
    }

function getTabDragLabel(item: TabItem, generatedTitlesEnabled: boolean): string {
  if (item.type === 'terminal') {
    return resolveTerminalTabTitle(item.data, generatedTitlesEnabled, item.data.title)
  }
  if (item.type === 'browser') {
    return getBrowserTabLabel(item.data)
  }
  return getEditorDisplayLabel(item.data)
}

function TabBarInner({
  tabs,
  activeTabId,
  groupId,
  worktreeId,
  expandedPaneByTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onNewTerminalTab,
  onNewTerminalWithShell,
  onNewBrowserTab,
  onOpenEntry,
  terminalOnly = false,
  showAgentLaunchItems = true,
  onNewFileTab,
  onOpenFileTab,
  onSetCustomTitle,
  onSetTabColor,
  onTogglePaneExpand,
  editorFiles,
  browserTabs,
  activeFileId,
  activeBrowserTabId,
  activeTabType,
  onActivateFile,
  onCloseFile,
  onActivateBrowserTab,
  onCloseBrowserTab,
  onDuplicateBrowserTab,
  onCloseAllFiles,
  onPinFile,
  tabBarOrder,
  onCreateSplitGroup,
  hoveredTabInsertion
}: TabBarProps): React.JSX.Element {
  const newTerminalShortcut = useShortcutLabel('tab.newTerminal')
  const newBrowserShortcut = useShortcutLabel('tab.newBrowser')
  const newFileShortcut = useShortcutLabel('tab.newMarkdown')
  const generatedTabTitlesEnabled = useAppStore((s) => s.settings?.tabAutoGenerateTitle === true)
  const gitStatusEntries = useAppStore(
    (s) => s.gitStatusByWorktree[worktreeId] ?? EMPTY_GIT_STATUS_ENTRIES
  )
  const defaultWindowsShell = useAppStore(
    (s) => s.settings?.terminalWindowsShell ?? 'powershell.exe'
  )
  const defaultWindowsPowerShellImplementation = useAppStore(
    (s) => s.settings?.terminalWindowsPowerShellImplementation ?? 'auto'
  )
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => s.settings?.activeRuntimeEnvironmentId?.trim() || null
  )
  const worktreeHasRemoteConnection = useAppStore((s) => {
    const worktree = Object.values(s.worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry.id === worktreeId)
    const repo = worktree ? s.repos?.find((entry) => entry.id === worktree.repoId) : null
    return Boolean(repo?.connectionId)
  })
  const unifiedNewTabLauncherEnabled = useAppStore(
    (s) => s.settings?.experimentalUnifiedNewTabLauncher === true
  )
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const agentCmdOverrides = useAppStore(
    (s) => s.settings?.agentCmdOverrides ?? EMPTY_AGENT_CMD_OVERRIDES
  )
  const connectionId = useAppStore((s) => {
    if (!unifiedNewTabLauncherEnabled) {
      return undefined
    }
    const allWorktrees = Object.values(s.worktreesByRepo ?? {}).flat()
    const worktree = allWorktrees.find((w) => w.id === worktreeId)
    if (!worktree) {
      return undefined
    }
    const repo = s.repos?.find((r) => r.id === worktree.repoId)
    return repo?.connectionId ?? null
  })
  const { detectedIds } = useDetectedAgents(connectionId)
  const agentLaunchOptions = useMemo(
    () =>
      buildTabAgentLaunchOptions(
        orderTabLaunchAgents(defaultAgent, detectedIds ?? []),
        agentCmdOverrides
      ),
    [agentCmdOverrides, defaultAgent, detectedIds]
  )
  const [runtimeHostPlatform, setRuntimeHostPlatform] = useState<NodeJS.Platform | null>(null)
  useEffect(() => {
    if (
      !(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ ||
      !activeRuntimeEnvironmentId
    ) {
      setRuntimeHostPlatform(null)
      return
    }
    let cancelled = false
    void window.api.runtime
      .getStatus()
      .then((status) => {
        if (!cancelled) {
          setRuntimeHostPlatform(status.hostPlatform ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeHostPlatform(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeRuntimeEnvironmentId])
  // Why: SSH-backed PTYs ignore local Windows shell overrides; showing these
  // entries there promises PowerShell/CMD/Git Bash but opens the remote shell.
  const shouldShowWindowsShellMenu =
    (isWindows || runtimeHostPlatform === 'win32') && !worktreeHasRemoteConnection
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    shouldShowWindowsShellMenu,
    false,
    getWindowsTerminalCapabilityOwnerKey(activeRuntimeEnvironmentId)
  )
  const resolvedGroupId = groupId ?? worktreeId

  const statusByRelativePath = useMemo(() => buildStatusMap(gitStatusEntries), [gitStatusEntries])

  // Why: Electron <webview> elements run in a separate process, so clicking
  // inside one never dispatches a pointerdown on the renderer document.
  // Radix DropdownMenu relies on document pointerdown to detect outside
  // clicks, so it misses webview clicks entirely. Listening for window blur
  // catches the moment focus leaves the renderer (including into a webview).
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false)
  const pendingNewTabMenuFocusRef = useRef<(() => void) | null>(null)
  const pendingNewTabMenuFocusAnimationRef = useRef<number | null>(null)
  const pendingNewTabMenuFocusRetryRef = useRef<number | null>(null)
  const clearPendingNewTabMenuFocusAnimation = (): void => {
    if (pendingNewTabMenuFocusAnimationRef.current === null) {
      return
    }
    cancelAnimationFrame(pendingNewTabMenuFocusAnimationRef.current)
    pendingNewTabMenuFocusAnimationRef.current = null
  }
  const clearPendingNewTabMenuFocusRetry = (): void => {
    if (pendingNewTabMenuFocusRetryRef.current === null) {
      return
    }
    window.clearTimeout(pendingNewTabMenuFocusRetryRef.current)
    pendingNewTabMenuFocusRetryRef.current = null
  }
  const focusNewActiveTerminalWhenReady = (
    previousActiveTabId: string | null,
    expiresAt: number
  ): void => {
    const state = useAppStore.getState()
    if (
      state.activeTabType === 'terminal' &&
      state.activeTabId &&
      state.activeTabId !== previousActiveTabId
    ) {
      focusTerminalTabSurface(state.activeTabId)
      return
    }
    if (Date.now() >= expiresAt) {
      return
    }
    pendingNewTabMenuFocusRetryRef.current = window.setTimeout(() => {
      pendingNewTabMenuFocusRetryRef.current = null
      focusNewActiveTerminalWhenReady(previousActiveTabId, expiresAt)
    }, NEW_TAB_MENU_TERMINAL_FOCUS_RETRY_MS)
  }
  const queueNewActiveTerminalFocusAfterNewTabMenuClose = (): void => {
    const previousActiveTabId = useAppStore.getState().activeTabId
    pendingNewTabMenuFocusRef.current = () => {
      // Why: paired web/SSH runtime tab creation is async; wait for the host
      // snapshot to publish the newly active terminal instead of focusing the
      // pre-existing active tab.
      focusNewActiveTerminalWhenReady(
        previousActiveTabId,
        Date.now() + NEW_TAB_MENU_TERMINAL_FOCUS_TIMEOUT_MS
      )
    }
  }
  const queueTerminalTabFocusAfterNewTabMenuClose = (tabId: string): void => {
    pendingNewTabMenuFocusRef.current = () => focusTerminalTabSurface(tabId)
  }
  const launchAgentFromNewTabEntry = (agent: TuiAgent): void => {
    const option = agentLaunchOptions.find((candidate) => candidate.agent === agent)
    const result = launchAgentInNewTab({
      agent,
      worktreeId,
      groupId: resolvedGroupId,
      launchSource: 'tab_bar_quick_launch'
    })
    if (!result) {
      toast.error(`Could not build launch command for ${option?.label ?? agent}.`)
      return
    }
    queueTerminalTabFocusAfterNewTabMenuClose(result.tabId)
  }
  const runPendingNewTabMenuFocusAfterClose = (): void => {
    const pendingFocus = pendingNewTabMenuFocusRef.current
    pendingNewTabMenuFocusRef.current = null
    clearPendingNewTabMenuFocusAnimation()
    clearPendingNewTabMenuFocusRetry()
    if (pendingFocus) {
      pendingNewTabMenuFocusAnimationRef.current = requestAnimationFrame(() => {
        pendingNewTabMenuFocusAnimationRef.current = null
        pendingFocus()
      })
    }
  }

  const clearPendingNewTabMenuFocusOnUnmountRef = useRef<
    ((node: HTMLDivElement | null) => void) | null
  >(null)
  if (clearPendingNewTabMenuFocusOnUnmountRef.current === null) {
    clearPendingNewTabMenuFocusOnUnmountRef.current = (node: HTMLDivElement | null): void => {
      if (node !== null) {
        return
      }
      // Why: the delayed focus handoff is scoped to this tab bar instance.
      // A root ref cleanup cancels it at the DOM owner boundary without an
      // otherwise cleanup-only React Effect.
      clearPendingNewTabMenuFocusAnimation()
      clearPendingNewTabMenuFocusRetry()
    }
  }
  const clearPendingNewTabMenuFocusOnUnmount = clearPendingNewTabMenuFocusOnUnmountRef.current

  useEffect(() => {
    if (!newTabMenuOpen) {
      return
    }
    const dismiss = (): void => setNewTabMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [newTabMenuOpen])

  const terminalMap = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs])
  const editorMap = useMemo(
    () => new Map((editorFiles ?? []).map((f) => [f.tabId ?? f.id, f])),
    [editorFiles]
  )
  const browserMap = useMemo(
    () => new Map((browserTabs ?? []).map((t) => [t.id, t])),
    [browserTabs]
  )

  const terminalIds = useMemo(() => tabs.map((t) => t.id), [tabs])
  const editorFileIds = useMemo(() => editorFiles?.map((f) => f.tabId ?? f.id) ?? [], [editorFiles])
  const browserTabIds = useMemo(() => browserTabs?.map((tab) => tab.id) ?? [], [browserTabs])

  // Build the unified ordered list, reconciling stored order with current items
  const orderedItems = useMemo(() => {
    const ids = reconcileTabOrder(tabBarOrder, terminalIds, editorFileIds, browserTabIds)
    const items: TabItem[] = []
    for (const id of ids) {
      const terminal = terminalMap.get(id)
      if (terminal) {
        items.push({
          type: 'terminal',
          id,
          unifiedTabId: terminal.unifiedTabId ?? terminal.id,
          data: terminal
        })
        continue
      }
      const file = editorMap.get(id)
      if (file) {
        items.push({ type: 'editor', id, unifiedTabId: file.tabId ?? file.id, data: file })
        continue
      }
      const browserTab = browserMap.get(id)
      if (browserTab) {
        items.push({
          type: 'browser',
          id,
          unifiedTabId: browserTab.tabId ?? browserTab.id,
          data: browserTab
        })
        continue
      }
    }
    return items
  }, [tabBarOrder, terminalIds, editorFileIds, browserTabIds, terminalMap, editorMap, browserMap])

  const sortableIds = useMemo(() => orderedItems.map((item) => item.id), [orderedItems])

  const activeIndicator =
    hoveredTabInsertion?.groupId === resolvedGroupId ? hoveredTabInsertion : null
  const dropIndicatorByVisibleId = useMemo(() => {
    const indicators = new Map<string, DropIndicator>()
    for (const edge of resolveTabIndicatorEdges(
      orderedItems.map((item) => item.id),
      activeIndicator
    )) {
      indicators.set(edge.visibleTabId, edge.side)
    }
    return indicators
  }, [activeIndicator, orderedItems])

  // Horizontal wheel scrolling for the tab strip
  const tabStripRef = useRef<HTMLDivElement>(null)
  const prevStripLenRef = useRef<{ worktreeId: string; len: number } | null>(null)
  const stickToEndRef = useRef(false)

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const isAtEnd = (): boolean => {
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      return el.scrollLeft >= max - 2
    }
    const onScroll = (): void => {
      // Only keep sticking while the user hasn't intentionally scrolled away.
      stickToEndRef.current = isAtEnd()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Seed based on initial position.
    onScroll()

    const ro = new ResizeObserver(() => {
      // If the user is pinned to the right edge, keep it pinned even as tab
      // labels (e.g. \"Terminal 5\" → branch name) expand and change scrollWidth.
      if (!stickToEndRef.current) {
        return
      }
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
    })
    ro.observe(el)

    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [])

  // Why: new and reopened tabs are appended to the right; without this the strip
  // keeps its scroll offset and the active tab can sit off-screen until the user
  // drags the tab bar horizontally.
  useLayoutEffect(() => {
    const strip = tabStripRef.current
    const len = orderedItems.length
    const prev = prevStripLenRef.current
    if (!strip) {
      prevStripLenRef.current = { worktreeId, len }
      return
    }
    if (!prev || prev.worktreeId !== worktreeId) {
      prevStripLenRef.current = { worktreeId, len }
      return
    }
    // If the user is pinned to the right edge, keep the close button visible
    // even when tab labels change length (e.g. "Terminal 5" → branch name).
    // Why: label changes don't necessarily change the strip element's own size,
    // so ResizeObserver won't fire; this effect runs on rerenders instead.
    if (stickToEndRef.current) {
      const scrollToEnd = (): void => {
        const el = tabStripRef.current
        if (!el) {
          return
        }
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
      }
      scrollToEnd()
      requestAnimationFrame(scrollToEnd)
    }
    if (len > prev.len) {
      const scrollToEnd = (): void => {
        const el = tabStripRef.current
        if (!el) {
          return
        }
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
        stickToEndRef.current = true
      }
      scrollToEnd()
      requestAnimationFrame(scrollToEnd)
    }
    prevStripLenRef.current = { worktreeId, len }
  }, [orderedItems, worktreeId])

  return (
    <div
      ref={clearPendingNewTabMenuFocusOnUnmount}
      className="flex items-stretch h-full overflow-hidden flex-1 min-w-0"
      // Why: only drops aimed at the top tab/session strip should open files in
      // Orca's editor. Terminal-pane drops need to keep inserting file paths
      // into the active coding CLI, so preload routes native OS drops based on
      // this explicit surface marker instead of treating the whole app as an
      // editor drop zone.
      data-native-file-drop-target="editor"
    >
      {/* Why: no strategy means dnd-kit does not animate siblings aside for
          the active tab. Combined with dropping transform/transition on the
          dragged tab (see SortableTab etc.), this keeps every tab visually
          anchored during a drag so only the blue insertion bar moves. */}
      <SortableContext items={sortableIds}>
        {/* Why: no-drag lets tab interactions work inside the titlebar's drag
            region. The outer container inherits drag so empty space after the
            "+" button remains window-draggable. */}
        <div
          ref={tabStripRef}
          // Why: only `border-r` on the strip — the trailing edge must stay
          // visible even when tabs overflow-scroll past the last tab. The
          // left edge is instead painted by the FIRST tab's own `border-l`
          // (see per-tab components) so its rendering is identical to every
          // between-tab separator. A strip-level `border-l` would render at
          // a different box than the tab's own `border-t`, producing a
          // heavier-looking L-corner at the leftmost tab when inactive.
          className="terminal-tab-strip flex items-stretch overflow-x-auto overflow-y-hidden border-r border-border"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {orderedItems.map((item, index) => {
            const dragData: TabDragItemData = {
              kind: 'tab',
              worktreeId,
              groupId: resolvedGroupId,
              unifiedTabId: item.unifiedTabId,
              visibleTabId: item.id,
              tabType: item.type,
              label: getTabDragLabel(item, generatedTabTitlesEnabled),
              iconPath: item.type === 'editor' ? item.data.filePath : undefined,
              color: item.type === 'terminal' ? (item.data.color ?? null) : null
            }
            if (item.type === 'terminal') {
              const terminalTab = {
                ...item.data,
                title: resolveTerminalTabTitle(
                  item.data,
                  generatedTabTitlesEnabled,
                  item.data.title
                )
              }
              return (
                <SortableTab
                  key={item.id}
                  tab={terminalTab}
                  tabCount={orderedItems.length}
                  hasTabsToRight={index < orderedItems.length - 1}
                  isActive={activeTabType === 'terminal' && item.id === activeTabId}
                  isExpanded={expandedPaneByTabId[item.id] === true}
                  onActivate={onActivate}
                  onClose={onClose}
                  onCloseOthers={onCloseOthers}
                  onCloseToRight={onCloseToRight}
                  onSetCustomTitle={onSetCustomTitle}
                  onSetTabColor={onSetTabColor}
                  onToggleExpand={onTogglePaneExpand}
                  onSplitGroup={(direction, sourceVisibleTabId) =>
                    onCreateSplitGroup?.(direction, sourceVisibleTabId)
                  }
                  dragData={dragData}
                  dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
                />
              )
            }
            if (item.type === 'browser') {
              return (
                <BrowserTab
                  key={item.id}
                  tab={item.data}
                  isActive={activeTabType === 'browser' && activeBrowserTabId === item.id}
                  hasTabsToRight={index < orderedItems.length - 1}
                  onActivate={() => onActivateBrowserTab?.(item.id)}
                  onClose={() => onCloseBrowserTab?.(item.id)}
                  onCloseToRight={() => onCloseToRight(item.id)}
                  onSplitGroup={(direction, sourceVisibleTabId) =>
                    onCreateSplitGroup?.(direction, sourceVisibleTabId)
                  }
                  onDuplicate={() => onDuplicateBrowserTab?.(item.id)}
                  dragData={dragData}
                  dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
                />
              )
            }
            return (
              <EditorFileTab
                key={item.id}
                file={item.data}
                isActive={activeTabType === 'editor' && activeFileId === item.id}
                hasTabsToRight={index < orderedItems.length - 1}
                statusByRelativePath={statusByRelativePath}
                onActivate={() => onActivateFile?.(item.id)}
                onClose={() => onCloseFile?.(item.id)}
                onCloseToRight={() => onCloseToRight(item.id)}
                onCloseAll={() => onCloseAllFiles?.()}
                onPin={() => onPinFile?.(item.data.id, item.data.tabId)}
                onSplitGroup={(direction, sourceVisibleTabId) =>
                  onCreateSplitGroup?.(direction, sourceVisibleTabId)
                }
                dragData={dragData}
                dropIndicator={dropIndicatorByVisibleId.get(item.id) ?? null}
              />
            )
          })}
        </div>
      </SortableContext>
      <DropdownMenu open={newTabMenuOpen} onOpenChange={setNewTabMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="ml-2 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title="New tab"
            // Why: aria-label matches the tooltip so E2E can locate the "+"
            // affordance via getByRole('button', { name: 'New tab' }). The
            // store-only createTab() round-trip that preceded this was a
            // tautology — it would pass even if the + button had been deleted.
            aria-label="New tab"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className={`${unifiedNewTabLauncherEnabled ? 'w-72 max-w-[calc(100vw-1rem)]' : 'min-w-[11rem]'} rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]`}
          onCloseAutoFocus={(e) => {
            // Why: terminal-producing menu actions activate a freshly-mounted
            // xterm. Radix's default focus restore sends focus back to the "+"
            // trigger after close, stealing it from the new terminal.
            e.preventDefault()
            runPendingNewTabMenuFocusAfterClose()
          }}
        >
          {!terminalOnly && onOpenEntry && unifiedNewTabLauncherEnabled ? (
            <>
              <TabBarCreateEntry
                worktreeId={worktreeId}
                groupId={resolvedGroupId}
                menuOpen={newTabMenuOpen}
                agentOptions={agentLaunchOptions}
                onLaunchAgent={launchAgentFromNewTabEntry}
                onOpenDefaultTerminal={() => {
                  queueNewActiveTerminalFocusAfterNewTabMenuClose()
                  onNewTerminalTab()
                }}
                onOpenEntry={onOpenEntry}
                onDidOpenEntry={() => setNewTabMenuOpen(false)}
              />
              <DropdownMenuSeparator />
            </>
          ) : null}
          {shouldShowWindowsShellMenu && onNewTerminalWithShell ? (
            // Why: previously the Windows path nested shell choices under a
            // Radix submenu. In practice the submenu frequently failed to open
            // on hover/click, and even when it worked the two-step expansion
            // hid the fact that multiple shells were available. Inlining all
            // shells as flat items — default pinned to the top with the
            // Ctrl+T hint — matches the "no popouts, show all options at
            // once" rec. Each entry uses a shell-specific icon (ShellIcon)
            // so PowerShell / CMD / Git Bash / WSL are distinguishable at a glance.
            // Labels use "CMD Prompt" instead of "Command Prompt" to keep
            // each row narrow enough that the shortcut hint fits without
            // wrapping.
            (() => {
              const allShells: {
                label: string
                shell: BuiltInWindowsTerminalShell
              }[] = [
                { label: 'PowerShell', shell: 'powershell.exe' },
                { label: 'CMD Prompt', shell: 'cmd.exe' },
                ...(windowsTerminalCapabilities.gitBashAvailable
                  ? ([{ label: 'Git Bash', shell: WINDOWS_GIT_BASH_SHELL }] as const)
                  : []),
                ...(windowsTerminalCapabilities.wslAvailable
                  ? ([{ label: 'WSL', shell: 'wsl.exe' }] as const)
                  : [])
              ]
              const defaultEntry =
                allShells.find((s) => s.shell === defaultWindowsShell) ?? allShells[0]
              const orderedShells = [
                defaultEntry,
                ...allShells.filter((s) => s.shell !== defaultEntry.shell)
              ]
              return orderedShells.map((entry, idx) => {
                const isDefault = idx === 0
                return (
                  <DropdownMenuItem
                    key={entry.shell}
                    onSelect={() => {
                      // Why: the top-level Windows shell menu models shell
                      // categories, not concrete executables. When the user
                      // picked PowerShell 7+ in advanced settings, launching the
                      // "PowerShell" menu item must preserve that implementation
                      // instead of forcing inbox powershell.exe.
                      queueNewActiveTerminalFocusAfterNewTabMenuClose()
                      onNewTerminalWithShell(
                        resolveWindowsShellLaunchTarget(
                          entry.shell,
                          defaultWindowsPowerShellImplementation,
                          windowsTerminalCapabilities.pwshAvailable
                        )
                      )
                    }}
                    className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
                  >
                    <ShellIcon shell={entry.shell} size={14} />
                    <span className="flex-1">New Terminal: {entry.label}</span>
                    {isDefault ? (
                      <DropdownMenuShortcut>{newTerminalShortcut}</DropdownMenuShortcut>
                    ) : null}
                  </DropdownMenuItem>
                )
              })
            })()
          ) : (
            <DropdownMenuItem
              onSelect={() => {
                queueNewActiveTerminalFocusAfterNewTabMenuClose()
                onNewTerminalTab()
              }}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <TerminalSquare className="size-4 text-muted-foreground" />
              New Terminal
              <DropdownMenuShortcut>{newTerminalShortcut}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {!terminalOnly && (
            <DropdownMenuItem
              onSelect={onNewBrowserTab}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <Globe className="size-4 text-muted-foreground" />
              New Browser Tab
              <DropdownMenuShortcut>{newBrowserShortcut}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {!terminalOnly && onNewFileTab && (
            <DropdownMenuItem
              onSelect={onNewFileTab}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <FilePlus className="size-4 text-muted-foreground" />
              New Markdown
              <DropdownMenuShortcut>{newFileShortcut}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {!terminalOnly && onOpenFileTab && (
            <DropdownMenuItem
              onSelect={onOpenFileTab}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <FileText className="size-4 text-muted-foreground" />
              Open Markdown...
            </DropdownMenuItem>
          )}
          {showAgentLaunchItems ? (
            <>
              <DropdownMenuSeparator />
              <QuickLaunchAgentMenuItems
                worktreeId={worktreeId}
                groupId={resolvedGroupId}
                onFocusTerminal={queueTerminalTabFocusAfterNewTabMenuClose}
              />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default React.memo(TabBarInner)
