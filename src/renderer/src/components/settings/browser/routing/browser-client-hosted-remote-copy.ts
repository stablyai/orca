import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getBrowserClientHostedRemoteTitle(t: Translate = translate): string {
  return t('settings.browser.clientHostedRemote.rowTitle', 'Remote server workspaces')
}

// New pages only: placement is fixed per page generation, so live pages are never migrated.
export function getBrowserClientHostedRemoteDescription(t: Translate = translate): string {
  return t(
    'settings.browser.clientHostedRemote.rowDescription',
    'Where pages render. Traffic always goes through the remote server. Applies to new pages only.'
  )
}
