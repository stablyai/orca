import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { flushSync } from 'react-dom'
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
        <span className="flex h-4 min-w-4 shrink-0 items-center justify-center" aria-hidden>
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
  /** Controls below the program row; the card then stays open under the pointer. */
  alert?: ReactNode | ((dismiss: () => void) => ReactNode)
  action?: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLElement>(null)
  // Remove the portal before navigation can start rendering a slower destination.
  const dismiss = () => flushSync(() => setOpen(false))
  const alert = typeof body.alert === 'function' ? body.alert(dismiss) : body.alert
  const interactive = body.alert !== undefined && body.alert !== null
  const canOpen = (): boolean => {
    const label = triggerRef.current?.querySelector<HTMLElement>('.tab-label')
    return interactive || !!(label && label.scrollWidth > label.clientWidth)
  }

  useEffect(() => {
    if (!open || interactive || body.action) {
      return
    }
    const label = triggerRef.current?.querySelector<HTMLElement>('.tab-label')
    if (!label) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (label.scrollWidth <= label.clientWidth) {
        setOpen(false)
      }
    })
    observer.observe(label)
    return () => observer.disconnect()
  }, [open, interactive, body.action, body.title])

  // A card with a control opens on hover whether or not the title is clipped, so the control stays reachable.
  if (body.action) {
    return (
      <HoverCard open={open} onOpenChange={setOpen} openDelay={500} closeDelay={100}>
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
          <TabHoverCardBody {...body} alert={alert} />
        </HoverCardContent>
      </HoverCard>
    )
  }
  return (
    <Tooltip
      open={open}
      onOpenChange={(nextOpen) => setOpen(nextOpen && canOpen())}
      disableHoverableContent={!interactive}
    >
      <TooltipTrigger
        ref={(node) => {
          triggerRef.current = node
        }}
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
        <TabHoverCardBody {...body} alert={alert} />
      </TooltipContent>
    </Tooltip>
  )
}

function stopTabStripEvent(event: SyntheticEvent): void {
  event.stopPropagation()
}
