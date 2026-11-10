import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIntlLocale } from '@/i18n/use-translate'
import { useNowSnapshot } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import {
  getNativeChatMessageDay,
  getNativeChatMessageTimeFormatter
} from '../../../../../../shared/native-chat/transcript/native-chat-message-time'

export function NativeChatMessageTimestamp({
  timestamp,
  focusable = false,
  className
}: {
  timestamp: number | null
  focusable?: boolean
  className?: string
}): React.JSX.Element | null {
  const intlLocale = useIntlLocale()
  const today = useNowSnapshot(30_000, getNativeChatMessageDay)
  useTranslation()
  if (timestamp === null) {
    return null
  }
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const formatter = getNativeChatMessageTimeFormatter(intlLocale, today)
  const fullLabel = formatter.formatFull(date)

  return (
    <Tooltip>
      {/* The label already carries the full date in every reading mode; the tooltip would repeat it. */}
      <TooltipTrigger asChild aria-describedby={undefined}>
        <time
          dateTime={date.toISOString()}
          aria-label={fullLabel}
          tabIndex={focusable ? 0 : undefined}
          className={cn(
            'rounded-md text-xs whitespace-nowrap text-chat-foreground-faint tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
        >
          {formatter.format(date, today.date)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {fullLabel}
      </TooltipContent>
    </Tooltip>
  )
}
