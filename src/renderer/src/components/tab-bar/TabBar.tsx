/* oxlint-disable max-lines -- Why: rendering the drop-indicator prop on each
 * of three distinct tab components (terminal, browser, editor) adds 3 lines
 * to a file that was already ~398 code lines on main. The per-type render
 * branches share little beyond drag data, so consolidating them would cost
 * more clarity than the ~5 lines of bloat is worth. */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { FilePlus, Globe, Plus, TerminalSquare } from 'lucide-react'
import type {
  BrowserTab as BrowserTabState,
  TerminalTab,
  WorkspaceVisibleTabType
} from '../../../../shared/types'
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
import { ShellIcon } from './shell-icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const isMac = navigator.userAgent.includes('Mac')
const isWindows = navigator.userAgent.includes('Windows')
const NEW_TERMINAL_SHORTCUT = isMac ? '⌘T' : 'Ctrl+T'
const NEW_BROWSER_SHORTCUT = isMac ? '⌘⇧B' : 'Ctrl+Shift+B'
const NEW_FILE_SHORTCUT = isMac ? '⌘⇧M' : 'Ctrl+Shift+M'

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
  onNewFileTab?: () => void
  /** Whether WSL is installed on this Windows machine. When true, the "+"
   *  dropdown shows a WSL option under the terminal submenu. */
  wslAvailable?: boolean
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

function getTabDragLabel(item: TabItem): string {
  if (item.type === 'terminal') {
    return item.data.customTitle ?? item.data.title
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
  onNewFileTab,
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
  hoveredTabInsertion,
  wslAvailable
}: TabBarProps): React.JSX.Element {
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const defaultWindowsShell = useAppStore(
    (s) => s.settings?.terminalWindowsShell ?? 'powershell.exe'
  )
  const resolvedGroupId = groupId ?? worktreeId
  const statusByRelativePath = useMemo(
    () => buildStatusMap(gitStatusByWorktree[worktreeId] ?? []),
    [worktreeId, gitStatusByWorktree]
  )

  // Why: Electron <webview> elements run in a separate process, so clicking
  // inside one never dispatches a pointerdown on the renderer document.
  // Radix DropdownMenu relies on document pointerdown to detect outside
  // clicks, so it misses webview clicks entirely. Listening for window blur
  // catches the moment focus leaves the renderer (including into a webview).
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false)
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

  const focusTerminalTabSurface = useCallback((tabId: string) => {
    // Why: creating a terminal from the "+" menu is a two-step focus race:
    // React must first mount the new TerminalPane/xterm, then Radix closes the
    // menu. Even after suppressing trigger focus restore, the terminal's hidden
    // textarea may not exist until the next paint. Double-rAF waits for that
    // commit so the new tab, not the "+" button, ends up owning keyboard focus.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scoped = document.querySelector(
          `[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea`
        ) as HTMLElement | null
        if (scoped) {
          scoped.focus()
          return
        }
        const fallback = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
        fallback?.focus()
      })
    })
  }, [])

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
              label: getTabDragLabel(item),
              color: item.type === 'terminal' ? (item.data.color ?? null) : null
            }
            if (item.type === 'terminal') {
              return (
                <SortableTab
                  key={item.id}
                  tab={item.data}
                  tabCount={tabs.length}
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
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="min-w-[11rem] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
          onCloseAutoFocus={(e) => {
            // Why: selecting "New Terminal" activates a freshly-mounted xterm on
            // the next frame. Radix's default focus restore sends focus back to
            // the "+" trigger after close, which steals it from the new tab and
            // makes the terminal look unfocused until the user clicks again.
            e.preventDefault()
          }}
        >
          {isWindows && onNewTerminalWithShell ? (
            // Why: previously the Windows path nested shell choices under a
            // Radix submenu. In practice the submenu frequently failed to open
            // on hover/click, and even when it worked the two-step expansion
            // hid the fact that multiple shells were available. Inlining all
            // shells as flat items — default pinned to the top with the
            // Ctrl+T hint — matches the "no popouts, show all options at
            // once" rec. Each entry uses a shell-specific icon (ShellIcon)
            // so PowerShell / CMD / WSL are distinguishable at a glance.
            // Labels use "CMD Prompt" instead of "Command Prompt" to keep
            // each row narrow enough that the shortcut hint fits without
            // wrapping.
            (() => {
              const allShells = [
                { label: 'PowerShell', shell: 'powershell.exe' },
                { label: 'CMD Prompt', shell: 'cmd.exe' },
                ...(wslAvailable ? [{ label: 'WSL', shell: 'wsl.exe' }] : [])
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
                      onNewTerminalWithShell(entry.shell)
                      const newActiveTabId = useAppStore.getState().activeTabId
                      if (newActiveTabId) {
                        focusTerminalTabSurface(newActiveTabId)
                      }
                    }}
                    className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
                  >
                    <ShellIcon shell={entry.shell} size={14} />
                    <span className="flex-1">New Terminal: {entry.label}</span>
                    {isDefault ? (
                      <DropdownMenuShortcut>{NEW_TERMINAL_SHORTCUT}</DropdownMenuShortcut>
                    ) : null}
                  </DropdownMenuItem>
                )
              })
            })()
          ) : (
            <DropdownMenuItem
              onSelect={() => {
                onNewTerminalTab()
                const newActiveTabId = useAppStore.getState().activeTabId
                if (newActiveTabId) {
                  focusTerminalTabSurface(newActiveTabId)
                }
              }}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <TerminalSquare className="size-4 text-muted-foreground" />
              New Terminal
              <DropdownMenuShortcut>{NEW_TERMINAL_SHORTCUT}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={onNewBrowserTab}
            className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
          >
            <Globe className="size-4 text-muted-foreground" />
            New Browser Tab
            <DropdownMenuShortcut>{NEW_BROWSER_SHORTCUT}</DropdownMenuShortcut>
          </DropdownMenuItem>
          {onNewFileTab && (
            <DropdownMenuItem
              onSelect={onNewFileTab}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <FilePlus className="size-4 text-muted-foreground" />
              New Markdown
              <DropdownMenuShortcut>{NEW_FILE_SHORTCUT}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          <QuickLaunchAgentMenuItems
            worktreeId={worktreeId}
            groupId={resolvedGroupId}
            onFocusTerminal={focusTerminalTabSurface}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default React.memo(TabBarInner)
