import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import '../../../../shared/constants'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/browser/browser-blank-page'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { formatBrowserTabUrlLabel } from './BrowserTab'

// Why: same fallback ladder as a local browser tab — a title equal to the URL is not a title.
export function getClientHostedBrowserRowLabel(row: ClientHostedBrowserRow, t?: Translate): string {
  if (
    !row.title ||
    row.title === row.url ||
    row.title === ORCA_BROWSER_BLANK_URL ||
    row.title === 'about:blank'
  ) {
    return formatBrowserTabUrlLabel(row.url, t)
  }
  return row.title
}

export function describeClientHostedBrowserRowHost(
  row: ClientHostedBrowserRow,
  t: Translate = translate
): string {
  if (row.hostAbsent) {
    return row.hostDeviceName
      ? t('browser.clientHosted.hostRowOfflineNamed', 'Offline — was hosted on {{device}}', {
          device: row.hostDeviceName
        })
      : t('browser.clientHosted.hostRowOffline', 'Offline — the device hosting it quit')
  }
  return row.hostDeviceName
    ? t('browser.clientHosted.hostRowNamed', 'Hosted on {{device}}', {
        device: row.hostDeviceName
      })
    : t('browser.clientHosted.hostRow', 'Hosted on another device')
}
