import { useId, useRef, useState } from 'react'
import { ChevronRight, TriangleAlertIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToastHeightChange } from '@/components/ui/toast-height-change'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Why: the raw Git guidance (incl. the owner worktree path) stays behind the title so the card reads in one line.
export function LocalBaseRefNotUpdatedCard({
  title,
  reason,
  detail,
  disableLabel,
  disableTooltip,
  closeLabel,
  onDisable,
  onClose,
  onResize
}: {
  title: string
  reason: string
  detail: string
  disableLabel: string
  disableTooltip: string
  closeLabel: string
  onDisable: () => void
  onClose: () => void
  onResize: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  useToastHeightChange(cardRef, onResize)
  return (
    <div
      ref={cardRef}
      data-toast-card
      className="flex w-full flex-col gap-1 rounded-[var(--radius)] border border-[var(--notice-border)] bg-[var(--notice-surface)] p-3 text-[13px] leading-5 text-popover-foreground shadow-notice"
    >
      <div className="flex items-center gap-2">
        <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={detailId}
        >
          <span className="truncate" title={title}>
            {title}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={`size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5"
          data-close-button
          aria-label={closeLabel}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="flex items-center gap-2 pl-6">
        <p className="min-w-0 flex-1 truncate text-popover-foreground/80" title={reason}>
          {reason}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="secondary" size="xs-notice" onClick={onDisable}>
              {disableLabel}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {disableTooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      {open ? (
        <p
          id={detailId}
          className="mt-1 ml-6 select-text whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
        >
          {detail}
        </p>
      ) : null}
    </div>
  )
}
