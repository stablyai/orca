import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import TabPreview from '../tab-bar/TabDragPreview'
import { TAB_CLUSTER_COLOR_CLASSES } from '../tab-bar/tab-cluster-colors'
import type { TabStripDragItemData } from './tab-drag-data'

export default function TabDragPreview({
  drag
}: {
  drag: TabStripDragItemData
}): React.JSX.Element {
  if (drag.kind === 'tab') {
    return <TabPreview drag={drag} />
  }
  const CollapseIcon = drag.collapsed ? ChevronRight : ChevronDown
  return (
    <div className="pointer-events-none flex h-full w-full items-center gap-1.5 rounded-sm border border-border bg-accent px-2 text-xs text-foreground shadow-floating">
      <span className={cn('size-2 shrink-0 rounded-full', TAB_CLUSTER_COLOR_CLASSES[drag.color])} />
      {drag.name ? <span className="truncate">{drag.name}</span> : null}
      <CollapseIcon className="size-3.5 shrink-0" />
    </div>
  )
}
