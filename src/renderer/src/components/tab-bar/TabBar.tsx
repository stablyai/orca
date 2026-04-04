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
import { Plus } from 'lucide-react'
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { buildStatusMap } from '../right-sidebar/status-display'
import type { OpenFile } from '../../store/slices/editor'
import SortableTab from './SortableTab'
import EditorFileTab from './EditorFileTab'

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
  onNewTab: () => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePaneExpand: (tabId: string) => void
  editorFiles?: OpenFile[]
  activeFileId?: string | null
  activeTabType?: 'terminal' | 'editor'
  onActivateFile?: (fileId: string) => void
  onCloseFile?: (fileId: string) => void
  onCloseAllFiles?: () => void
  onPinFile?: (fileId: string) => void
  tabBarOrder?: string[]
}

type TabItem =
  | { type: 'terminal'; id: string; data: TerminalTab }
  | { type: 'editor'; id: string; data: OpenFile }

/**
 * Reconcile stored order with the current set of terminal + editor tabs.
 * Keeps items that still exist in their stored positions, appends new items at the end.
 */
function reconcileOrder(
  storedOrder: string[] | undefined,
  terminalIds: string[],
  editorFileIds: string[]
): string[] {
  const validIds = new Set([...terminalIds, ...editorFileIds])

  const result: string[] = (storedOrder ?? []).filter((id) => validIds.has(id))
  const inResult = new Set(result)

  for (const id of terminalIds) {
    if (!inResult.has(id)) {
      result.push(id)
    }
  }
  for (const id of editorFileIds) {
    if (!inResult.has(id)) {
      result.push(id)
    }
  }
  return result
}

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
  onNewTab,
  onSetCustomTitle,
  onSetTabColor,
  onTogglePaneExpand,
  editorFiles,
  activeFileId,
  activeTabType,
  onActivateFile,
  onCloseFile,
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

  const terminalIds = useMemo(() => tabs.map((t) => t.id), [tabs])
  const editorFileIds = useMemo(() => editorFiles?.map((f) => f.id) ?? [], [editorFiles])

  // Build the unified ordered list, reconciling stored order with current items
  const orderedItems = useMemo(() => {
    const ids = reconcileOrder(tabBarOrder, terminalIds, editorFileIds)
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
      }
    }
    return items
  }, [tabBarOrder, terminalIds, editorFileIds, terminalMap, editorMap])

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
      className="flex items-stretch h-9 bg-card border-b border-border overflow-hidden shrink-0"
      // Why: only drops aimed at the top tab/session strip should open files in
      // Orca's editor. Terminal-pane drops need to keep inserting file paths
      // into the active coding CLI, so preload routes native OS drops based on
      // this explicit surface marker instead of treating the whole app as an
      // editor drop zone.
      data-native-file-drop-target="editor"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
          <div
            ref={tabStripRef}
            className="terminal-tab-strip flex items-stretch overflow-x-auto overflow-y-hidden"
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
      <button
        className="flex items-center justify-center w-9 h-full shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent/50"
        onClick={onNewTab}
        title="New terminal (Cmd+T)"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  )
}
