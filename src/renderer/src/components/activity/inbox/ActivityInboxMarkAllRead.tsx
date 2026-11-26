import React from 'react'
import { CheckCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** The inbox header's one-click Mark all read; the options menu keeps its own copy. */
export function ActivityInboxMarkAllRead({
  disabled,
  onMarkAllRead
}: {
  disabled: boolean
  onMarkAllRead: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.activity.ActivityPrototypePage.023ff75afe', 'Mark all read')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Why a span: a disabled button fires no pointer events, so its tooltip would never show. */}
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label={label}
            disabled={disabled}
            onClick={onMarkAllRead}
          >
            <CheckCheck className="size-3.5" strokeWidth={2.25} />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
