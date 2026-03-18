import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { X, Plus, Terminal as TerminalIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TerminalTab } from '../../../shared/types'

interface SortableTabProps {
  tab: TerminalTab
  tabCount: number
  hasTabsToRight: boolean
  isActive: boolean
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
}

const TAB_COLORS = [
  { label: 'None', value: null },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Teal', value: '#14b8a6' },
  { label: 'Gray', value: '#9ca3af' }
]

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

function SortableTab({
  tab,
  tabCount,
  hasTabsToRight,
  isActive,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onSetCustomTitle,
  onSetTabColor
}: SortableTabProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : 1
  }
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
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={`group relative flex items-center h-full px-3 text-sm cursor-pointer select-none shrink-0 border-r border-border ${
            isActive
              ? 'bg-background text-foreground border-b-transparent'
              : 'bg-card text-muted-foreground hover:text-foreground hover:bg-accent/50'
          }`}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            onActivate(tab.id)
            listeners?.onPointerDown?.(e)
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              e.stopPropagation()
              onClose(tab.id)
            }
          }}
        >
          <TerminalIcon className="w-3.5 h-3.5 mr-1.5 shrink-0 text-muted-foreground" />
          <span className="truncate max-w-[130px] mr-1.5">{tab.customTitle ?? tab.title}</span>
          {tab.color && (
            <span
              className="mr-1.5 size-2 rounded-full shrink-0"
              style={{ backgroundColor: tab.color }}
            />
          )}
          <button
            className={`flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
              isActive
                ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
            }`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
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
        <DropdownMenuContent className="w-56" sideOffset={0} align="start">
          <DropdownMenuItem onSelect={() => onClose(tab.id)}>Close</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCloseOthers(tab.id)} disabled={tabCount <= 1}>
            Close Others
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCloseToRight(tab.id)} disabled={!hasTabsToRight}>
            Close Tabs To The Right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              const next = window.prompt('Change tab title', tab.customTitle ?? tab.title)
              if (next === null) return
              const trimmed = next.trim()
              onSetCustomTitle(tab.id, trimmed.length > 0 ? trimmed : null)
            }}
          >
            Change Title
          </DropdownMenuItem>
          <div className="px-2 pt-1.5 pb-1">
            <div className="text-xs font-medium text-muted-foreground mb-1.5">Tab Color</div>
            <div className="flex flex-wrap gap-2">
              {TAB_COLORS.map((color) => {
                const isSelected = tab.color === color.value
                return (
                  <DropdownMenuItem
                    key={color.label}
                    className={`relative h-4 w-4 min-w-4 p-0 rounded-full border ${
                      isSelected
                        ? 'ring-1 ring-foreground/70 ring-offset-1 ring-offset-popover'
                        : ''
                    } ${
                      color.value
                        ? 'border-transparent'
                        : 'border-muted-foreground/50 bg-transparent'
                    }`}
                    style={color.value ? { backgroundColor: color.value } : undefined}
                    onSelect={() => {
                      onSetTabColor(tab.id, color.value)
                    }}
                  >
                    {color.value === null && (
                      <span className="absolute block h-px w-3 rotate-45 bg-muted-foreground/80" />
                    )}
                  </DropdownMenuItem>
                )
              })}
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

interface TabBarProps {
  tabs: TerminalTab[]
  activeTabId: string | null
  worktreeId: string
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onReorder: (worktreeId: string, tabIds: string[]) => void
  onNewTab: () => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
}

export default function TabBar({
  tabs,
  activeTabId,
  worktreeId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onReorder,
  onNewTab,
  onSetCustomTitle,
  onSetTabColor
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
      if (!over || active.id === over.id) return

      const oldIndex = tabIds.indexOf(active.id as string)
      const newIndex = tabIds.indexOf(over.id as string)
      if (oldIndex === -1 || newIndex === -1) return

      const newOrder = arrayMove(tabIds, oldIndex, newIndex)
      onReorder(worktreeId, newOrder)
    },
    [tabIds, worktreeId, onReorder]
  )

  return (
    <div className="flex items-stretch h-9 bg-card border-b border-border overflow-hidden shrink-0">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          <div className="flex items-stretch overflow-x-auto">
            {tabs.map((tab, index) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                tabCount={tabs.length}
                hasTabsToRight={index < tabs.length - 1}
                isActive={tab.id === activeTabId}
                onActivate={onActivate}
                onClose={onClose}
                onCloseOthers={onCloseOthers}
                onCloseToRight={onCloseToRight}
                onSetCustomTitle={onSetCustomTitle}
                onSetTabColor={onSetTabColor}
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
