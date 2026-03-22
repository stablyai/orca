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
  onReorder: (worktreeId: string, tabIds: string[]) => void
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
  onCloseAllFiles
}: TabBarProps): React.JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 }
    })
  )

  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) {
        return
      }

      const oldIndex = tabIds.indexOf(active.id as string)
      const newIndex = tabIds.indexOf(over.id as string)
      if (oldIndex === -1 || newIndex === -1) {
        return
      }

      const newOrder = arrayMove(tabIds, oldIndex, newIndex)
      onReorder(worktreeId, newOrder)
    },
    [tabIds, worktreeId, onReorder]
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

  const handleCloseOtherEditorFiles = useCallback(
    (keepFileId: string) => {
      if (!editorFiles || !onCloseFile) {
        return
      }
      for (const f of editorFiles) {
        if (f.id !== keepFileId) {
          onCloseFile(f.id)
        }
      }
    },
    [editorFiles, onCloseFile]
  )

  return (
    <div className="flex items-stretch h-9 bg-card border-b border-border overflow-hidden shrink-0">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          <div
            ref={tabStripRef}
            className="terminal-tab-strip flex items-stretch overflow-x-auto overflow-y-hidden"
          >
            {tabs.map((tab, index) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                tabCount={tabs.length}
                hasTabsToRight={index < tabs.length - 1}
                isActive={activeTabType === 'terminal' && tab.id === activeTabId}
                isExpanded={expandedPaneByTabId[tab.id] === true}
                onActivate={onActivate}
                onClose={onClose}
                onCloseOthers={onCloseOthers}
                onCloseToRight={onCloseToRight}
                onSetCustomTitle={onSetCustomTitle}
                onSetTabColor={onSetTabColor}
                onToggleExpand={onTogglePaneExpand}
              />
            ))}
            {/* Editor tabs - after terminal tabs */}
            {editorFiles?.map((file) => (
              <EditorFileTab
                key={file.id}
                file={file}
                isActive={activeTabType === 'editor' && activeFileId === file.id}
                editorFileCount={editorFiles.length}
                onActivate={() => onActivateFile?.(file.id)}
                onClose={() => onCloseFile?.(file.id)}
                onCloseOthers={() => handleCloseOtherEditorFiles(file.id)}
                onCloseAll={() => onCloseAllFiles?.()}
              />
            ))}
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
