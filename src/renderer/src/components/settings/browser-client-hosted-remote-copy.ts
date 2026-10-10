import { translate } from '@/i18n/i18n'

export function getBrowserClientHostedRemoteTitle(): string {
  return translate('settings.browser.clientHostedRemote.rowTitle', 'Remote server workspaces')
}

// New pages only: placement is fixed per page generation, so live pages are never migrated.
export function getBrowserClientHostedRemoteDescription(): string {
  return translate(
    'settings.browser.clientHostedRemote.rowDescription',
    'Where pages render. Traffic always goes through the remote server. Applies to new pages only.'
  )
}
