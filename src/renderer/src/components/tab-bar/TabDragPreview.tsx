import { Globe, Terminal as TerminalIcon } from 'lucide-react'
import { useThemedFileIcon } from '@/hooks/useFileIcon'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'

export default function TabDragPreview({ drag }: { drag: TabDragItemData }): React.JSX.Element {
  const ThemedIcon = useThemedFileIcon(drag.iconPath ?? drag.label)
  const Icon =
    drag.tabType === 'browser' ? Globe : drag.tabType === 'editor' ? ThemedIcon : TerminalIcon
  return (
    <div className="pointer-events-none flex h-full w-full items-center gap-1.5 rounded-sm border border-border bg-accent px-2 text-xs text-foreground shadow-md">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{drag.label}</span>
      {drag.color ? (
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: drag.color }} />
      ) : null}
    </div>
  )
}
