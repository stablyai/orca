import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import type { CloudShareFailureCode } from '../../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'

export function shareErrorMessage(code: CloudShareFailureCode): string {
  switch (code) {
    case 'limit':
      return translate(
        'auto.components.right.sidebar.CloudShare.errorLimit',
        'This workspace has as many links as it can. Turn one off first.'
      )
    case 'not_found':
      return translate(
        'auto.components.right.sidebar.CloudShare.errorNotFound',
        'That link is no longer active.'
      )
    case 'unauthorized':
      return translate(
        'auto.components.right.sidebar.CloudShare.errorUnauthorized',
        'Sign in to Orca again, then try again.'
      )
    case 'invalid_request':
      return translate(
        'auto.components.right.sidebar.CloudShare.errorInvalid',
        'That port can’t be shared.'
      )
    case 'not_cloud':
    case 'unavailable':
      return translate(
        'auto.components.right.sidebar.CloudShare.errorUnavailable',
        'Couldn’t reach Orca Cloud. Try again.'
      )
  }
}

/** Re-renders every 30s while enabled, so "Expires in …" and ended rows stay current. */
export function useShareClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) {
      return
    }
    setNow(Date.now())
    // Pauses while the window is hidden and catches up when it shows again.
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 30_000 })
  }, [enabled])
  return now
}
