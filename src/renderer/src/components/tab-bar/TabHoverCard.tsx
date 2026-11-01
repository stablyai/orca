import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { flushSync } from 'react-dom'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function TabHoverCard({
  children,
  title,
  icon,
  programName,
  description,
  alert,
  showWhenTitleFits = false,
  onOpenChange
}: {
  children: ReactNode
  title: string
  icon: ReactNode
  programName: string
  description?: string
  /** Controls below the program row; the card then stays open under the pointer. */
  alert?: ReactNode | ((dismiss: () => void) => ReactNode)
  /** The card carries details beyond the title, so it opens even when the title is not clipped. */
  showWhenTitleFits?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLElement>(null)
  // Remove the portal before navigation can start rendering a slower destination.
  const dismiss = () => flushSync(() => setOpen(false))
  const interactive = alert !== undefined && alert !== null
  const opensUnclipped = interactive || showWhenTitleFits
  const canOpen = (): boolean => {
    const label = triggerRef.current?.querySelector<HTMLElement>('.tab-label')
    return opensUnclipped || !!(label && label.scrollWidth > label.clientWidth)
  }

  useEffect(() => {
    if (!open || opensUnclipped) {
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
  }, [open, opensUnclipped, title])

  return (
    <Tooltip
      open={open}
      onOpenChange={(nextOpen) => {
        const next = nextOpen && canOpen()
        setOpen(next)
        onOpenChange?.(next)
      }}
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
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center" aria-hidden>
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
