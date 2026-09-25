import { useTranslation } from 'react-i18next'
import { getIntlLocale } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

let cached: {
  locale: string
  time: Intl.DateTimeFormat
  full: Intl.DateTimeFormat
} | null = null

function getTimestampFormatters(): NonNullable<typeof cached> {
  const locale = getIntlLocale()
  if (!cached || cached.locale !== locale) {
    cached = {
      locale,
      time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' })
    }
  }
  return cached
}

export function NativeChatMessageTimestamp({
  timestamp,
  focusable = false,
  className
}: {
  timestamp: number | null
  focusable?: boolean
  className?: string
}): React.JSX.Element | null {
  useTranslation()
  if (timestamp === null) {
    return null
  }
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const formatters = getTimestampFormatters()

  return (
    <time
      dateTime={date.toISOString()}
      aria-label={formatters.full.format(date)}
      tabIndex={focusable ? 0 : undefined}
      className={cn(
        'rounded-md text-xs whitespace-nowrap text-muted-foreground tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      {formatters.time.format(date)}
    </time>
  )
}
