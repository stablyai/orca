import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** The small red "… failed" chip; its output can be long, so it opens a dialog rather than a tooltip. */
export function AgentCommandFailedChip({
  label,
  ariaLabel,
  tooltip,
  tooltipSide = 'top',
  onOpen,
  onPointerDown
}: {
  label: string
  ariaLabel: string
  tooltip: string
  tooltipSide?: 'top' | 'right'
  onOpen: React.MouseEventHandler<HTMLButtonElement>
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          onPointerDown={onPointerDown}
          onClick={onOpen}
          onDoubleClick={onOpen}
          className="h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive has-[>svg]:!px-0.5"
          aria-label={ariaLabel}
        >
          <AlertCircle className="size-2.5" />
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={tooltipSide === 'right' ? 8 : 4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
