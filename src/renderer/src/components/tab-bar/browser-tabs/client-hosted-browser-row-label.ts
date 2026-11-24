import type { ClientHostedBrowserRow } from '../../../../../shared/browser/client-hosting/client-hosted-browser-rows'
import '../../../../../shared/orca-profiles/constants'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { formatBrowserTabTitleLabel } from './browser-tab-label'

export function getClientHostedBrowserRowLabel(row: ClientHostedBrowserRow, t?: Translate): string {
  return formatBrowserTabTitleLabel(row.title, row.url, t)
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
