import { useEffect, useState } from 'react'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { formatUiNarrowDuration, formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
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
        'That port can’t be shared: 2222, 6768 and 6769 are used by Orca in the workspace.'
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

/** "50m" / "23h" / "6d": time left, for the dense sidebar row. */
export function formatShareTimeLeft(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000))
  if (minutes < 60) {
    return formatUiNarrowDuration(minutes, 'minute')
  }
  const hours = Math.round(minutes / 60)
  return hours < 48
    ? formatUiNarrowDuration(hours, 'hour')
    : formatUiNarrowDuration(Math.round(hours / 24), 'day')
}

/** "in 50m" / "in 23h" / "in 6d". */
export function formatShareExpiry(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000))
  if (minutes < 60) {
    return formatUiNarrowRelativeTime(minutes, 'minute')
  }
  const hours = Math.round(minutes / 60)
  return hours < 48
    ? formatUiNarrowRelativeTime(hours, 'hour')
    : formatUiNarrowRelativeTime(Math.round(hours / 24), 'day')
}

/** "Nov 9, 12:50 PM" in the UI language: the exact moment a link stops working. */
export function formatShareExpiryDate(expiresAt: number): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(expiresAt)
}
