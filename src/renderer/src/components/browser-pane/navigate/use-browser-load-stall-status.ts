import { useSyncExternalStore } from 'react'
import type { BrowserLoadStall } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { useTranslate } from '@/i18n/use-translate'

// One subscription for the app, so a pane that remounts mid-stall still knows its load is stuck.
const stalls = new Map<string, BrowserLoadStall>()
const listeners = new Set<() => void>()
let listening = false

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!listening) {
    listening = true
    window.api.browser.onLoadStall((event) => {
      if (event.stall) {
        stalls.set(event.browserPageId, event.stall)
      } else if (!stalls.delete(event.browserPageId)) {
        return
      }
      for (const notify of listeners) {
        notify()
      }
    })
  }
  return () => listeners.delete(listener)
}

/** Status-bubble text for a page load that hasn't committed after a few seconds. */
export function useBrowserLoadStallStatus(browserPageId: string): string | null {
  const t = useTranslate()
  const stall = useSyncExternalStore(
    subscribe,
    () => stalls.get(browserPageId) ?? null,
    () => null
  )
  if (!stall) {
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
