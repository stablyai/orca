import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TerminalSquare } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getTabRootStateClasses,
  getTabStripBorderClasses
} from '@/components/tab-bar/drop-indicator'
import { translate } from '@/i18n/i18n'
import { peersFlatTabKey, type PeersFlatTab } from './peers-flat-tab-list'

function SortablePeersTab({
  tab,
  isActive,
  onSelect
}: {
  tab: PeersFlatTab
  isActive: boolean
  onSelect: (tab: PeersFlatTab) => void
}): React.JSX.Element {
  const key = peersFlatTabKey(tab)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key
  })
  const label =
    tab.title ||
    translate('auto.components.peers.PeersPageTabStrip.untitledTerminal', 'Untitled terminal')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={setNodeRef}
          type="button"
          aria-selected={isActive}
          onClick={() => onSelect(tab)}
          style={{ transform: CSS.Transform.toString(transform), transition }}
          className={`relative flex h-full min-w-0 max-w-48 items-center px-2 text-xs cursor-pointer select-none outline-none ${getTabStripBorderClasses(true, { includeTopBorder: false })} ${getTabRootStateClasses(isActive)} ${isDragging ? 'z-20 opacity-80' : ''}`}
          {...attributes}
          {...listeners}
          role="tab"
        >
          {isActive ? <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden /> : null}
          <TerminalSquare className="mr-1 size-3 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Tabs across the selected host's granted terminals — reuses the workspace tab
 *  strip's visual classes (pure helpers, no tab-store coupling) so both bars read
 *  as the same control. Drag to reorder; the order is kept per host. */
export function PeersPageTabStrip({
  tabs,
  activeKey,
  onSelect,
  onReorder
}: {
  tabs: PeersFlatTab[]
  activeKey: string
  onSelect: (tab: PeersFlatTab) => void
  onReorder: (handles: string[]) => void
}): React.JSX.Element | null {
  // Why: a click must stay a click — only a deliberate 4px drag starts sorting.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  if (tabs.length === 0) {
    return null
  }

  const keys = tabs.map((tab) => peersFlatTabKey(tab))

  return (
    <DndContext
      sensors={sensors}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) {
          return
        }
        const from = keys.indexOf(String(active.id))
        const to = keys.indexOf(String(over.id))
        if (from === -1 || to === -1) {
          return
        }
        onReorder(arrayMove(tabs, from, to).map((tab) => tab.handle))
      }}
    >
      <SortableContext items={keys} strategy={horizontalListSortingStrategy}>
        <div
          role="tablist"
          className="flex h-8 shrink-0 items-end overflow-x-auto border-b border-border bg-card"
        >
          {tabs.map((tab) => (
            <SortablePeersTab
              key={peersFlatTabKey(tab)}
              tab={tab}
              isActive={peersFlatTabKey(tab) === activeKey}
              onSelect={onSelect}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
