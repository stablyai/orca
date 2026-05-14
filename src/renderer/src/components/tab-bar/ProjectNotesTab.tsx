import { useEffect, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { Columns2, FileText, Rows2, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  type DropIndicator
} from './drop-indicator'

export type ProjectNotesTabState = {
  id: string
  label: string
  isDirty: boolean
}

export function ProjectNotesTab({
  tab,
  isActive,
  hasTabsToRight,
  onActivate,
  onClose,
  onCloseToRight,
  onSplitGroup,
  dragData,
  dropIndicator
}: {
  tab: ProjectNotesTabState
  isActive: boolean
  hasTabsToRight: boolean
  onActivate: () => void
  onClose: () => void
  onCloseToRight: () => void
  onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef } = useSortable({
    id: tab.id,
    data: dragData
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  return (
    <>
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        onClick={onActivate}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
        className={`group relative flex h-full min-w-[120px] max-w-[220px] items-center gap-1.5 border-l border-border px-2 text-xs ${
          hasTabsToRight ? 'border-r border-r-border/70' : ''
        } ${isActive ? 'bg-background text-foreground' : 'bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
        role="tab"
        aria-selected={isActive}
      >
        {dropIndicator ? <div className={getDropIndicatorClasses(dropIndicator)} /> : null}
        <FileText className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{tab.label}</span>
        <div className="relative flex size-4 shrink-0 items-center justify-center">
          {tab.isDirty ? (
            <span className="absolute size-1.5 rounded-full bg-foreground/60 group-hover:hidden" />
          ) : null}
          <button
            type="button"
            className={`flex size-4 items-center justify-center rounded-sm ${
              tab.isDirty
                ? 'hidden text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex'
                : isActive
                  ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  : 'text-transparent hover:!bg-muted hover:!text-foreground group-hover:text-muted-foreground'
            }`}
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
            aria-label="Close Project Notes"
          >
            <X className="size-3" />
          </button>
        </div>
        {isActive ? <div className={ACTIVE_TAB_INDICATOR_CLASSES} /> : null}
      </div>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <span
            className="fixed size-px"
            style={{ left: menuPoint.x, top: menuPoint.y }}
            aria-hidden
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onSplitGroup('right', tab.id)}>
            <Columns2 className="size-4" />
            Split Right
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('down', tab.id)}>
            <Rows2 className="size-4" />
            Split Down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onCloseToRight}>Close Tabs to Right</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onClose}>
            Close
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
