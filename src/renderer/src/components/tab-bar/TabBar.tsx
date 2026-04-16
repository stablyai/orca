import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
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
import BrowserTab from './BrowserTab'
import { reconcileTabOrder } from './reconcile-order'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
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
  onNewBrowserTab: () => void
  onNewFileTab?: () => void
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
  onCloseAllFiles?: () => void
  onPinFile?: (fileId: string, tabId?: string) => void
  tabBarOrder?: string[]
  onCreateSplitGroup?: (
    direction: 'left' | 'right' | 'up' | 'down',
    sourceVisibleTabId?: string
  ) => void
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
  onCloseAllFiles,
  onPinFile,
  tabBarOrder,
  onCreateSplitGroup
}: TabBarProps): React.JSX.Element {
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const resolvedGroupId = groupId ?? worktreeId
  const statusByRelativePath = useMemo(
    () => buildStatusMap(gitStatusByWorktree[worktreeId] ?? []),
    [worktreeId, gitStatusByWorktree]
  )

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
            const dragData: TabDragItemData = {
              kind: 'tab',
              worktreeId,
              groupId: resolvedGroupId,
              unifiedTabId: item.unifiedTabId,
              visibleTabId: item.id,
              tabType: item.type
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
                  dragData={dragData}
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
              />
            )
          })}
        </div>
      </SortableContext>
      <DropdownMenu>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default React.memo(TabBarInner)
