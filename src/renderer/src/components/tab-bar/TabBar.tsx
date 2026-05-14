/* oxlint-disable max-lines -- Why: rendering the drop-indicator prop on each
 * of three distinct tab components (terminal, browser, editor) adds 3 lines
 * to a file that was already ~398 code lines on main. The per-type render
 * branches share little beyond drag data, so consolidating them would cost
 * more clarity than the ~5 lines of bloat is worth. */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { FilePlus, Globe, Plus, TerminalSquare, FileText } from 'lucide-react'
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
import { ProjectNotesTab, type ProjectNotesTabState } from './ProjectNotesTab'
import { QuickLaunchAgentMenuItems } from './QuickLaunchButton'
import type { DropIndicator } from './drop-indicator'
import { reconcileTabOrder } from './reconcile-order'
import type { HoveredTabInsertion, TabDragItemData } from '../tab-group/useTabDragSplit'
import { resolveTabIndicatorEdges } from '../tab-group/tab-insertion'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { ShellIcon } from './shell-icons'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { NoteSummary } from '../../../../shared/notes-types'

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
  terminalOnly?: boolean
  showAgentLaunchItems?: boolean
  onNewFileTab?: () => void
  onNewNotesTab?: (noteId?: string) => void
  notesWorktreeId?: string | null
  /** Whether WSL is installed on this Windows machine. When true, the "+"
   *  dropdown shows a WSL option under the terminal submenu. */
  wslAvailable?: boolean
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePaneExpand: (tabId: string) => void
  editorFiles?: (OpenFile & { tabId?: string })[]
  browserTabs?: (BrowserTabState & { tabId?: string })[]
  notesTabs?: ProjectNotesTabState[]
  activeFileId?: string | null
  activeBrowserTabId?: string | null
  activeNotesTabId?: string | null
  activeTabType?: WorkspaceVisibleTabType
  onActivateFile?: (fileId: string) => void
  onCloseFile?: (fileId: string) => void
  onActivateBrowserTab?: (tabId: string) => void
  onCloseBrowserTab?: (tabId: string) => void
  onActivateNotesTab?: (tabId: string) => void
  onCloseNotesTab?: (tabId: string) => void
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
  | { type: 'notes'; id: string; unifiedTabId: string; data: ProjectNotesTabState }

function getTabDragLabel(item: TabItem): string {
  if (item.type === 'terminal') {
    return item.data.customTitle ?? item.data.title
  }
  if (item.type === 'browser') {
    return getBrowserTabLabel(item.data)
  }
  if (item.type === 'notes') {
    return item.data.label
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
  terminalOnly = false,
  showAgentLaunchItems = true,
  onNewFileTab,
  onNewNotesTab,
  notesWorktreeId,
  onSetCustomTitle,
  onSetTabColor,
  onTogglePaneExpand,
  editorFiles,
  browserTabs,
  notesTabs,
  activeFileId,
  activeBrowserTabId,
  activeNotesTabId,
  activeTabType,
  onActivateFile,
  onCloseFile,
  onActivateBrowserTab,
  onCloseBrowserTab,
  onActivateNotesTab,
  onCloseNotesTab,
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
  const defaultWindowsPowerShellImplementation = useAppStore(
    (s) => s.settings?.terminalWindowsPowerShellImplementation ?? 'auto'
  )
  const [pwshAvailable, setPwshAvailable] = useState(false)
  const [projectNotes, setProjectNotes] = useState<NoteSummary[]>([])
  const [projectNotesLoading, setProjectNotesLoading] = useState(false)
  const [projectNotesError, setProjectNotesError] = useState<string | null>(null)
  const [projectNotesMenuOpen, setProjectNotesMenuOpen] = useState(false)
  useEffect(() => {
    if (!isWindows) {
      setPwshAvailable(false)
      return
    }

    void window.api.pwsh.isAvailable().then(setPwshAvailable)
  }, [])
  const resolvedGroupId = groupId ?? worktreeId
  const targetNotesWorktreeId = notesWorktreeId ?? worktreeId

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

  useEffect(() => {
    if (!newTabMenuOpen) {
      setProjectNotesMenuOpen(false)
      return
    }
    const refreshProjectNotes = async (): Promise<void> => {
      if (!onNewNotesTab) {
        return
      }
      let context: { projectId: string; worktreeId: string } | null = null
      if (targetNotesWorktreeId) {
        const state = useAppStore.getState()
        const worktree = Object.values(state.worktreesByRepo)
          .flat()
          .find((candidate) => candidate.id === targetNotesWorktreeId)
        if (worktree) {
          const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
          context = { projectId: repo?.id ?? worktree.repoId, worktreeId: targetNotesWorktreeId }
        }
      }
      if (!context) {
        setProjectNotes([])
        setProjectNotesError(null)
        return
      }
      setProjectNotesLoading(true)
      setProjectNotesError(null)
      try {
        const result = await window.api.notes.list({
          projectId: context.projectId,
          worktreeId: context.worktreeId,
          limit: 100
        })
        setProjectNotes(result.notes)
      } catch (err) {
        setProjectNotesError(err instanceof Error ? err.message : String(err))
      } finally {
        setProjectNotesLoading(false)
      }
    }
    void refreshProjectNotes()
  }, [newTabMenuOpen, onNewNotesTab, targetNotesWorktreeId])

  const terminalMap = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs])
  const editorMap = useMemo(
    () => new Map((editorFiles ?? []).map((f) => [f.tabId ?? f.id, f])),
    [editorFiles]
  )
  const browserMap = useMemo(
    () => new Map((browserTabs ?? []).map((t) => [t.id, t])),
    [browserTabs]
  )
  const notesMap = useMemo(() => new Map((notesTabs ?? []).map((t) => [t.id, t])), [notesTabs])

  const terminalIds = useMemo(() => tabs.map((t) => t.id), [tabs])
  const editorFileIds = useMemo(() => editorFiles?.map((f) => f.tabId ?? f.id) ?? [], [editorFiles])
  const browserTabIds = useMemo(() => browserTabs?.map((tab) => tab.id) ?? [], [browserTabs])
  const notesTabIds = useMemo(() => notesTabs?.map((tab) => tab.id) ?? [], [notesTabs])

  // Build the unified ordered list, reconciling stored order with current items
  const orderedItems = useMemo(() => {
    const ids = reconcileTabOrder(
      tabBarOrder,
      terminalIds,
      editorFileIds,
      browserTabIds,
      notesTabIds
    )
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
      const notesTab = notesMap.get(id)
      if (notesTab) {
        items.push({ type: 'notes', id, unifiedTabId: notesTab.id, data: notesTab })
      }
    }
    return items
  }, [
    tabBarOrder,
    terminalIds,
    editorFileIds,
    browserTabIds,
    notesTabIds,
    terminalMap,
    editorMap,
    browserMap,
    notesMap
  ])

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
            if (item.type === 'notes') {
              return (
                <ProjectNotesTab
                  key={item.id}
                  tab={item.data}
                  isActive={activeTabType === 'notes' && activeNotesTabId === item.id}
                  hasTabsToRight={index < orderedItems.length - 1}
                  onActivate={() => onActivateNotesTab?.(item.id)}
                  onClose={() => onCloseNotesTab?.(item.id)}
                  onCloseToRight={() => onCloseToRight(item.id)}
                  onSplitGroup={(direction, sourceVisibleTabId) =>
                    onCreateSplitGroup?.(direction, sourceVisibleTabId)
                  }
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
              const allShells: {
                label: string
                shell: 'powershell.exe' | 'cmd.exe' | 'wsl.exe'
              }[] = [
                { label: 'PowerShell', shell: 'powershell.exe' },
                { label: 'CMD Prompt', shell: 'cmd.exe' },
                ...(wslAvailable ? ([{ label: 'WSL', shell: 'wsl.exe' }] as const) : [])
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
                      onNewTerminalWithShell(
                        resolveWindowsShellLaunchTarget(
                          entry.shell,
                          defaultWindowsPowerShellImplementation,
                          pwshAvailable
                        )
                      )
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
              }}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <TerminalSquare className="size-4 text-muted-foreground" />
              New Terminal
              <DropdownMenuShortcut>{NEW_TERMINAL_SHORTCUT}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {!terminalOnly && (
            <DropdownMenuItem
              onSelect={onNewBrowserTab}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <Globe className="size-4 text-muted-foreground" />
              New Browser Tab
              <DropdownMenuShortcut>{NEW_BROWSER_SHORTCUT}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {!terminalOnly && onNewFileTab && (
            <DropdownMenuItem
              onSelect={onNewFileTab}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <FilePlus className="size-4 text-muted-foreground" />
              New Markdown
              <DropdownMenuShortcut>{NEW_FILE_SHORTCUT}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {onNewNotesTab && (
            <DropdownMenuSub open={projectNotesMenuOpen} onOpenChange={setProjectNotesMenuOpen}>
              <DropdownMenuSubTrigger
                className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
                onPointerEnter={() => setProjectNotesMenuOpen(true)}
                onFocus={() => setProjectNotesMenuOpen(true)}
                onClick={() => {
                  // Why: this row looks like the other creation commands in
                  // the + menu. Keep hover-to-pick-saved-note, but make a
                  // direct click create a fresh note instead of only opening
                  // the submenu.
                  onNewNotesTab()
                  setProjectNotesMenuOpen(false)
                  setNewTabMenuOpen(false)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') {
                    return
                  }
                  event.preventDefault()
                  onNewNotesTab()
                  setProjectNotesMenuOpen(false)
                  setNewTabMenuOpen(false)
                }}
              >
                <FileText className="size-4 text-muted-foreground" />
                Project Notes
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                <DropdownMenuItem
                  onSelect={() => onNewNotesTab()}
                  className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
                >
                  <FileText className="size-3.5 text-muted-foreground" />
                  New Project Note
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {projectNotesLoading ? (
                  <DropdownMenuItem disabled className="text-muted-foreground">
                    Loading notes...
                  </DropdownMenuItem>
                ) : projectNotesError ? (
                  <DropdownMenuItem disabled className="text-destructive">
                    Failed to load notes
                  </DropdownMenuItem>
                ) : projectNotes.length === 0 ? (
                  <DropdownMenuItem disabled className="text-muted-foreground">
                    No saved notes
                  </DropdownMenuItem>
                ) : (
                  <div className="max-h-64 overflow-y-auto pr-0.5">
                    {projectNotes.map((note) => (
                      <DropdownMenuItem
                        key={note.id}
                        onSelect={() => onNewNotesTab(note.id)}
                        className="items-start gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5"
                      >
                        <FileText className="mt-0.5 size-3.5 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{note.title}</span>
                          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                            {note.preview || note.relativePath}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {showAgentLaunchItems ? (
            <>
              <DropdownMenuSeparator />
              <QuickLaunchAgentMenuItems
                worktreeId={worktreeId}
                groupId={resolvedGroupId}
                onFocusTerminal={focusTerminalTabSurface}
              />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default React.memo(TabBarInner)
