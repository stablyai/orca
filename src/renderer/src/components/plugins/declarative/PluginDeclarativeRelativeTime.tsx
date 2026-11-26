import { useEffect, useState } from 'react'
import { useIntlLocale } from '@/i18n/use-translate'
import {
  formatPluginRelativeTime,
  pluginRelativeTimeTickMs,
  type PluginRelativeTimeFormat
} from '../../../../../shared/plugins/declarative/plugin-declarative-relative-time'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { DATE_TIME_NUMERIC } from '../../../../../shared/i18n/regional-date-time-format'

/** Now, re-read as often as the words for `at` can change: Orca ticks it, the plugin never polls. */
function useRelativeNow(at: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), pluginRelativeTimeTickMs(at - now))
    return () => clearTimeout(timer)
  }, [at, now])
  return now
}

export function PluginDeclarativeRelativeTimeText({
  at,
  format = 'short'
}: {
  at: number
  format?: PluginRelativeTimeFormat
}): React.JSX.Element {
  const intlLocale = useIntlLocale()
  const now = useRelativeNow(at)
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={uiDateTimeFormat(DATE_TIME_NUMERIC, intlLocale).format(new Date(at))}
    >
      {formatPluginRelativeTime(at, now, format, intlLocale)}
    </time>
  )
}
