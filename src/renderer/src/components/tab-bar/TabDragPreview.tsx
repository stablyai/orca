import { FileCode, Globe, Terminal as TerminalIcon, FileText } from 'lucide-react'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'

// Why: rendered inside dnd-kit's DragOverlay (a document-level portal), so
// the dragged tab stays visible under the cursor even when it leaves its
// source tab strip. The DragOverlay sizes its wrapper from the source
// element's rect; `h-full w-full` on this chip fills that wrapper so the
// ghost lines up with the cursor instead of rendering as a tiny pill in
// the wrapper's top-left.
export default function TabDragPreview({ drag }: { drag: TabDragItemData }): React.JSX.Element {
  const Icon =
    drag.tabType === 'browser'
      ? Globe
      : drag.tabType === 'editor'
        ? FileCode
        : drag.tabType === 'notes'
          ? FileText
          : TerminalIcon
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
