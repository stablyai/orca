import { translate } from '@/i18n/i18n'

export function getBrowserSshWorkspaceRoutingTitle(): string {
  return translate('settings.browser.sshWorkspaceRouting.rowTitle', 'SSH workspaces')
}

export function getBrowserSshWorkspaceRoutingDescription(): string {
  return translate(
    'settings.browser.sshWorkspaceRouting.rowDescription',
    'Where browser traffic leaves from. Pages always render on this device.'
  )
}
