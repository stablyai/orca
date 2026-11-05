import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { translate } from '@/i18n/i18n'
import { formatBrowserTabUrlLabel } from './BrowserTab'

// Why: same fallback ladder as a local browser tab — a title equal to the URL is not a title.
export function getClientHostedBrowserRowLabel(row: ClientHostedBrowserRow): string {
  if (
    !row.title ||
    row.title === row.url ||
    row.title === ORCA_BROWSER_BLANK_URL ||
    row.title === 'about:blank'
  ) {
    return formatBrowserTabUrlLabel(row.url)
  }
  return row.title
}

export function describeClientHostedBrowserRowHost(row: ClientHostedBrowserRow): string {
  if (row.hostAbsent) {
    return row.hostDeviceName
      ? translate(
          'browser.clientHosted.hostRowOfflineNamed',
          'Offline — was hosted on {{device}}',
          {
            device: row.hostDeviceName
          }
        )
      : translate('browser.clientHosted.hostRowOffline', 'Offline — the device hosting it quit')
  }
  return row.hostDeviceName
    ? translate('browser.clientHosted.hostRowNamed', 'Hosted on {{device}}', {
        device: row.hostDeviceName
      })
    : translate('browser.clientHosted.hostRow', 'Hosted on another device')
}
