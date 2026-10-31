import { useState, type ReactNode, type SyntheticEvent } from 'react'
import { flushSync } from 'react-dom'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function TabHoverCard({
  children,
  title,
  icon,
  programName,
  description,
  alert
}: {
  children: ReactNode
  title: string
  icon: ReactNode
  programName: string
  description?: string
  /** Controls below the program row; the card then stays open under the pointer. */
  alert?: ReactNode | ((dismiss: () => void) => ReactNode)
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Remove the portal before navigation can start rendering a slower destination.
  const dismiss = () => flushSync(() => setOpen(false))
  const interactive = alert !== undefined && alert !== null
  return (
    <Tooltip open={open} onOpenChange={setOpen} disableHoverableContent={!interactive}>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          // Nested controls own their focus hints.
          if (event.target !== event.currentTarget) {
            event.preventDefault()
          }
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        variant={interactive ? 'tab-preview-interactive' : 'tab-preview'}
        showArrow={false}
        side="bottom"
        align="start"
        sideOffset={0}
        data-tab-hover-card="true"
        // Why: React bubbles portal events to the tab strip, whose handlers would act on the tab.
        onContextMenu={stopTabStripEvent}
        onPointerDown={stopTabStripEvent}
        onMouseDown={stopTabStripEvent}
        onClick={stopTabStripEvent}
        onDoubleClick={stopTabStripEvent}
      >
        <div className="space-y-2 text-left">
          <div className="space-y-1">
            <div className="break-words font-medium" data-tab-hover-card-title>
              {title}
            </div>
            {description && <div className="break-all text-muted-foreground">{description}</div>}
          </div>
          <div
            className="flex items-center gap-2 text-muted-foreground"
            data-tab-hover-card-program
          >
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              {icon}
            </span>
            <span className="min-w-0 break-all">{programName}</span>
          </div>
          {typeof alert === 'function' ? alert(dismiss) : alert}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function stopTabStripEvent(event: SyntheticEvent): void {
  event.stopPropagation()
}
