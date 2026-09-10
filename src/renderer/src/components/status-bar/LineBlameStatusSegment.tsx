import React from 'react'
import { History } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { formatBlameAbsoluteTime, formatBlameRelativeTime } from '@/lib/line-blame-format'
import { useLineBlame } from '@/lib/use-line-blame'

export function LineBlameStatusSegment({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const { blame } = useLineBlame(true)

  // Why no active-file check: blame is non-null only when a saved, tracked file
  // is focused, so the hook already answers that question.
  if (!blame) {
    return null
  }

  const relative = formatBlameRelativeTime(blame.authorTimeMs)
  const label = blame.isUncommitted
    ? translate('auto.components.status.bar.LineBlameStatusSegment.uncommitted', 'Uncommitted')
    : relative
      ? `${blame.author} · ${relative}`
      : blame.author
  const fullDate = formatBlameAbsoluteTime(blame.authorTimeMs)
  const tooltip = blame.isUncommitted
    ? translate(
        'auto.components.status.bar.LineBlameStatusSegment.uncommittedTooltip',
        'This line has uncommitted changes.'
      )
    : [blame.summary, `${blame.author}${fullDate ? `, ${fullDate}` : ''}`, blame.sha.slice(0, 7)]
        .filter(Boolean)
        .join(' — ')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-label={label}>
          <History className="size-3 shrink-0" />
          {iconOnly ? null : (
            <span className={compact ? 'max-w-[120px] truncate' : 'max-w-[200px] truncate'}>
              {label}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-sm">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
