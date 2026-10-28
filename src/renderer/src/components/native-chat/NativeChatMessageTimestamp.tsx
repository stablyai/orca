import { useTranslation } from 'react-i18next'
import { getIntlLocale } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  NATIVE_CHAT_MESSAGE_FULL_TIME_FORMAT,
  NATIVE_CHAT_MESSAGE_TIME_FORMAT
} from '../../../../shared/native-chat/transcript/native-chat-message-time'

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
      time: new Intl.DateTimeFormat(locale, NATIVE_CHAT_MESSAGE_TIME_FORMAT),
      full: new Intl.DateTimeFormat(locale, NATIVE_CHAT_MESSAGE_FULL_TIME_FORMAT)
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
        'rounded-md text-xs whitespace-nowrap text-chat-foreground-faint tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      {formatters.time.format(date)}
    </time>
  )
}
