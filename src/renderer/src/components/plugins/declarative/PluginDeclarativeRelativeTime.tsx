import { useEffect, useState } from 'react'
import { getIntlLocale } from '@/i18n/i18n'
import {
  formatPluginRelativeTime,
  pluginRelativeTimeTickMs,
  type PluginRelativeTimeFormat
} from '../../../../../shared/plugins/declarative/plugin-declarative-relative-time'

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
  const now = useRelativeNow(at)
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString(getIntlLocale())}
    >
      {formatPluginRelativeTime(at, now, format, getIntlLocale())}
    </time>
  )
}
