import { useEffect, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { Columns2, Network, Rows2, X } from 'lucide-react'
import type { ArchitectureWorkspace } from '../../../../shared/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  type DropIndicator
} from './drop-indicator'

export function getArchitectureTabLabel(tab: ArchitectureWorkspace): string {
  return tab.label ?? tab.title ?? 'Architecture'
}

export default function ArchitectureTab({
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
  tab: ArchitectureWorkspace
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

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const dismiss = (): void => setMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [menuOpen])

  return (
    <>
      <div
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          className={`group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none shrink-0 outline-none focus:outline-none focus-visible:outline-none border-t ${hasTabsToRight ? 'border-r' : ''} border-border bg-card ${getDropIndicatorClasses(dropIndicator ?? null)} ${
            isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return
            }
            onActivate()
            listeners?.onPointerDown?.(event)
          }}
          onMouseDown={(event) => {
            if (event.button === 1) {
              event.preventDefault()
            }
          }}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }
          }}
        >
          {isActive && <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden />}
          <Network className="w-3 h-3 mr-1 shrink-0 text-emerald-500" />
          <span className="truncate max-w-[120px] mr-1">{getArchitectureTabLabel(tab)}</span>
          <button
            className={`flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
              isActive
                ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
            }`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="min-w-[11rem] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
          sideOffset={0}
          align="start"
        >
          <DropdownMenuItem onSelect={() => onSplitGroup('up', tab.id)}>
            <Rows2 className="mr-1.5 size-3.5" />
            Split Up
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('down', tab.id)}>
            <Rows2 className="mr-1.5 size-3.5" />
            Split Down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('left', tab.id)}>
            <Columns2 className="mr-1.5 size-3.5" />
            Split Left
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('right', tab.id)}>
            <Columns2 className="mr-1.5 size-3.5" />
            Split Right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onClose}>Close</DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseToRight} disabled={!hasTabsToRight}>
            Close Tabs To The Right
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
