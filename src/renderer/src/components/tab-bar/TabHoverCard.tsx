import type { ReactNode, SyntheticEvent } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

function TabHoverCardBody({
  title,
  icon,
  programName,
  description,
  action,
  alert
}: {
  title: string
  icon: ReactNode
  programName: string
  description?: string
  alert?: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-2 text-left">
      <div className="space-y-1">
        <div className="break-words font-medium" data-tab-hover-card-title>
          {title}
        </div>
        {description && <div className="break-all text-muted-foreground">{description}</div>}
      </div>
      <div className="flex items-center gap-2 text-muted-foreground" data-tab-hover-card-program>
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
          {icon}
        </span>
        <span className="min-w-0 break-all">{programName}</span>
      </div>
      {alert}
      {action}
    </div>
  )
}

/** `action` makes the card a hover card the pointer can enter, so its control is clickable. */
export function TabHoverCard({
  children,
  ...body
}: {
  children: ReactNode
  title: string
  icon: ReactNode
  programName: string
  description?: string
  alert?: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  if (body.action) {
    return (
      <HoverCard openDelay={500} closeDelay={100}>
        <HoverCardTrigger asChild>{children}</HoverCardTrigger>
        <HoverCardContent
          variant="tab-preview"
          side="bottom"
          align="start"
          sideOffset={0}
          data-tab-hover-card="true"
          onContextMenu={stopTabStripEvent}
          onPointerDown={stopTabStripEvent}
          onMouseDown={stopTabStripEvent}
          onClick={stopTabStripEvent}
          onDoubleClick={stopTabStripEvent}
        >
          <TabHoverCardBody {...body} />
        </HoverCardContent>
      </HoverCard>
    )
  }
  const interactive = body.alert !== undefined && body.alert !== null
  return (
    <Tooltip disableHoverableContent={!interactive}>
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
        onContextMenu={stopTabStripEvent}
        onPointerDown={stopTabStripEvent}
        onMouseDown={stopTabStripEvent}
        onClick={stopTabStripEvent}
        onDoubleClick={stopTabStripEvent}
      >
        <TabHoverCardBody {...body} />
      </TooltipContent>
    </Tooltip>
  )
}

function stopTabStripEvent(event: SyntheticEvent): void {
  event.stopPropagation()
}
