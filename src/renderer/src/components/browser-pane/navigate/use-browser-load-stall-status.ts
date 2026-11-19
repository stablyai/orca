import { useEffect, useState } from 'react'
import type { BrowserLoadStall } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { useTranslate } from '@/i18n/use-translate'

/** Status-bubble text for a load whose request went to the network and has had no response. */
export function useBrowserLoadStallStatus(browserPageId: string): string | null {
  const t = useTranslate()
  const [stall, setStall] = useState<BrowserLoadStall | null>(null)
  useEffect(() => {
    setStall(null)
    return window.api.browser.onLoadStall((event) => {
      if (event.browserPageId === browserPageId) {
        setStall(event.stall)
      }
    })
  }, [browserPageId])
  if (stall?.phase !== 'waiting') {
    return null
  }
  // HTTPS sites usually share one HTTP/2 connection, so the pool is named only for plain HTTP.
  return stall.scheme === 'http' && stall.hiddenSameOriginPages > 0
    ? t(
        'browser.loadStall.waitingForConnection',
        'Waiting for a free connection to {{host}}. {{count}} hidden tabs on this site may be holding them.',
        {
          host: stall.host,
          count: stall.hiddenSameOriginPages,
          defaultValue_one:
            'Waiting for a free connection to {{host}}. 1 hidden tab on this site may be holding them.'
        }
      )
    : t('browser.loadStall.waitingForHost', 'Waiting for {{host}}…', { host: stall.host })
}
