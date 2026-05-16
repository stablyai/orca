import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import type { MouseEvent, ReactElement } from 'react'

export function DiffSectionHeader({
  path,
  dirty,
  collapsed,
  added,
  removed,
  onToggle,
  onOpenInEditor
}: {
  path: string
  dirty: boolean
  collapsed: boolean
  added: number
  removed: number
  onToggle: () => void
  onOpenInEditor: (event: MouseEvent) => void
}): ReactElement {
  return (
    <div
      className="sticky top-0 z-10 bg-background flex items-center w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors group cursor-pointer"
      onClick={onToggle}
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span
          role="button"
          tabIndex={0}
          className="cursor-copy hover:underline"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            // Why: stop both mouse-down and click on the path affordance so
            // the parent section-toggle row cannot consume the interaction.
            void window.api.ui.writeClipboardText(path).catch((error) => {
              console.error('Failed to copy diff path:', error)
            })
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
              return
            }
            event.preventDefault()
            event.stopPropagation()
            void window.api.ui.writeClipboardText(path).catch((error) => {
              console.error('Failed to copy diff path:', error)
            })
          }}
          title="Copy path"
        >
          {path}
        </span>
        {dirty && <span className="font-medium ml-1">M</span>}
        {(added > 0 || removed > 0) && (
          <span className="tabular-nums ml-2">
            {added > 0 && <span className="text-green-600 dark:text-green-500">+{added}</span>}
            {added > 0 && removed > 0 && <span> </span>}
            {removed > 0 && <span className="text-red-500">-{removed}</span>}
          </span>
        )}
      </span>
      <div className="flex items-center gap-1 shrink-0 ml-2">
        <button
          className="p-0.5 rounded text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={onOpenInEditor}
          title="Open in editor"
        >
          <ExternalLink className="size-3.5" />
        </button>
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
    </div>
  )
}
