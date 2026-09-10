import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/**
 * Odoo-style record pager (‹ 3/24 ›): steps to the previous/next ticket in the
 * currently visible list without leaving the panel. Floats over the header's
 * empty right side instead of living inside OdooTicketHeader, which this
 * feature does not own.
 */
export function OdooTicketPager({
  position,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext
}: {
  position: { index: number; total: number } | null
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
}): React.JSX.Element {
  return (
    <div className="absolute right-4 top-4 z-10 flex items-center gap-0.5 rounded-md border border-border/60 bg-background/85 px-1 py-0.5 shadow-xs backdrop-blur-sm">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={!hasPrevious}
            aria-label={translate(
              'auto.components.odoo.ticket.pager.a22df7a932',
              'Previous ticket'
            )}
            onClick={onPrevious}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate('auto.components.odoo.ticket.pager.a22df7a932', 'Previous ticket')}
        </TooltipContent>
      </Tooltip>
      {position ? (
        <span className="px-1 text-[11px] tabular-nums text-muted-foreground">
          {position.index + 1}/{position.total}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={!hasNext}
            aria-label={translate('auto.components.odoo.ticket.pager.983fd8b806', 'Next ticket')}
            onClick={onNext}
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate('auto.components.odoo.ticket.pager.983fd8b806', 'Next ticket')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
