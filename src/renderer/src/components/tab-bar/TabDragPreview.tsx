import { createElement } from 'react'
import { Globe, Terminal as TerminalIcon } from 'lucide-react'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import { AgentIcon } from '@/lib/agent-catalog'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'

// Match the resting tab’s agent identity in the drag overlay.
function LeadingIcon({ drag }: { drag: TabDragItemData }): React.JSX.Element {
  if (drag.tabType === 'browser') {
    return <Globe className="h-3.5 w-3.5 shrink-0" />
  }
  if (drag.tabType === 'editor') {
    return createElement(FileTypeIcon, {
      filePath: drag.iconPath ?? drag.label,
      className: 'h-3.5 w-3.5 shrink-0'
    })
  }
  if (drag.agent) {
    return <AgentIcon agent={drag.agent} size={14} />
  }
  return <TerminalIcon className="h-3.5 w-3.5 shrink-0" />
}

// Fill DragOverlay’s source-sized wrapper so the portal ghost stays aligned with the cursor outside its strip.
export default function TabDragPreview({ drag }: { drag: TabDragItemData }): React.JSX.Element {
  return (
    <div className="pointer-events-none flex h-full w-full items-center gap-1.5 rounded-sm border border-border bg-accent px-2 text-xs text-foreground shadow-md">
      <span className="inline-flex shrink-0">
        <LeadingIcon drag={drag} />
      </span>
      <span className="truncate">{drag.label}</span>
      {drag.color ? (
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: drag.color }} />
      ) : null}
    </div>
  )
}
