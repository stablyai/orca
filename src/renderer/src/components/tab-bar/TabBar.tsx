import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { Globe, Plus, TerminalSquare } from 'lucide-react'
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
import BrowserTab from './BrowserTab'
import { reconcileTabOrder } from './reconcile-order'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const isMac = navigator.userAgent.includes('Mac')
const NEW_TERMINAL_SHORTCUT = isMac ? '⌘T' : 'Ctrl+T'
const NEW_BROWSER_SHORTCUT = isMac ? '⌘⇧B' : 'Ctrl+Shift+B'

type TabBarProps = {
  tabs: TerminalTab[]
  activeTabId: string | null
  worktreeId: string
  expandedPaneByTabId: Record<string, boolean>
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onReorder: (worktreeId: string, order: string[]) => void
  onNewTerminalTab: () => void
  onNewBrowserTab: () => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePaneExpand: (tabId: string) => void
  editorFiles?: OpenFile[]
  browserTabs?: BrowserTabState[]
  activeFileId?: string | null
  activeBrowserTabId?: string | null
  activeTabType?: WorkspaceVisibleTabType
  onActivateFile?: (fileId: string) => void
  onCloseFile?: (fileId: string) => void
  onActivateBrowserTab?: (tabId: string) => void
  onCloseBrowserTab?: (tabId: string) => void
  onCloseAllFiles?: () => void
  onPinFile?: (fileId: string) => void
  tabBarOrder?: string[]
}

type TabItem =
  | { type: 'terminal'; id: string; data: TerminalTab }
  | { type: 'editor'; id: string; data: OpenFile }
  | { type: 'browser'; id: string; data: BrowserTabState }

export default function TabBar({
  tabs,
  activeTabId,
  worktreeId,
  expandedPaneByTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onReorder,
  onNewTerminalTab,
  onNewBrowserTab,
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
  onCloseAllFiles,
  onPinFile,
  tabBarOrder
}: TabBarProps): React.JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 }
    })
  )

  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const statusByRelativePath = useMemo(
    () => buildStatusMap(gitStatusByWorktree[worktreeId] ?? []),
    [worktreeId, gitStatusByWorktree]
  )

  const terminalMap = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs])
  const editorMap = useMemo(() => new Map((editorFiles ?? []).map((f) => [f.id, f])), [editorFiles])
  const browserMap = useMemo(
    () => new Map((browserTabs ?? []).map((t) => [t.id, t])),
    [browserTabs]
  )

  const terminalIds = useMemo(() => tabs.map((t) => t.id), [tabs])
  const editorFileIds = useMemo(() => editorFiles?.map((f) => f.id) ?? [], [editorFiles])
  const browserTabIds = useMemo(() => browserTabs?.map((tab) => tab.id) ?? [], [browserTabs])

  // Build the unified ordered list, reconciling stored order with current items
  const orderedItems = useMemo(() => {
    const ids = reconcileTabOrder(tabBarOrder, terminalIds, editorFileIds, browserTabIds)
    const items: TabItem[] = []
    for (const id of ids) {
      const terminal = terminalMap.get(id)
      if (terminal) {
        items.push({ type: 'terminal', id, data: terminal })
        continue
      }
      const file = editorMap.get(id)
      if (file) {
        items.push({ type: 'editor', id, data: file })
        continue
      }
      const browserTab = browserMap.get(id)
      if (browserTab) {
        items.push({ type: 'browser', id, data: browserTab })
      }
    }
    return items
  }, [tabBarOrder, terminalIds, editorFileIds, browserTabIds, terminalMap, editorMap, browserMap])

  const sortableIds = useMemo(() => orderedItems.map((item) => item.id), [orderedItems])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) {
        return
      }

      const oldIndex = sortableIds.indexOf(active.id as string)
      const newIndex = sortableIds.indexOf(over.id as string)
      if (oldIndex === -1 || newIndex === -1) {
        return
      }

      const newOrder = arrayMove(sortableIds, oldIndex, newIndex)
      onReorder(worktreeId, newOrder)
    },
    [sortableIds, worktreeId, onReorder]
  )

  // Horizontal wheel scrolling for the tab strip
  const tabStripRef = useRef<HTMLDivElement>(null)
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
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
          {/* Why: no-drag lets tab interactions work inside the titlebar's drag
              region. The outer container inherits drag so empty space after the
              "+" button remains window-draggable. */}
          <div
            ref={tabStripRef}
            className="terminal-tab-strip flex items-stretch overflow-x-auto overflow-y-hidden"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {orderedItems.map((item, index) => {
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
                  onPin={() => onPinFile?.(item.id)}
                />
              )
            })}
          </div>
        </SortableContext>
      </DndContext>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="mx-1 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title="New tab"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-[11rem] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
        >
          <DropdownMenuItem
            onSelect={onNewTerminalTab}
            className="gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium"
          >
            <TerminalSquare className="size-4 text-muted-foreground" />
            New Terminal
            <DropdownMenuShortcut>{NEW_TERMINAL_SHORTCUT}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onNewBrowserTab}
            className="gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium"
          >
            <Globe className="size-4 text-muted-foreground" />
            New Browser Tab
            <DropdownMenuShortcut>{NEW_BROWSER_SHORTCUT}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
