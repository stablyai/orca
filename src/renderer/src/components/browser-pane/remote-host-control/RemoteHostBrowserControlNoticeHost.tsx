import { useEffect } from 'react'
import { showRemoteHostBrowserControlNotice } from './remote-host-browser-control-notice'

/** Main sends the notice once per SSH host; this only shows it and relays the answer. */
export function RemoteHostBrowserControlNoticeHost(): null {
  useEffect(() => {
    const browser = window.api.browser
    const stop = browser.stopRemoteHostControl
    const disallow = browser.disallowRemoteHostControl
    if (!stop || !disallow) {
      return
    }
    return browser.onRemoteHostControlNotice?.((notice) =>
      showRemoteHostBrowserControlNotice(notice, { stop, disallow })
    )
  }, [])
  return null
}
