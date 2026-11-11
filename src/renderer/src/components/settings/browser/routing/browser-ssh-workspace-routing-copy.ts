import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getBrowserSshWorkspaceRoutingTitle(t: Translate = translate): string {
  return t('settings.browser.sshWorkspaceRouting.rowTitle', 'SSH workspaces')
}

export function getBrowserSshWorkspaceRoutingDescription(t: Translate = translate): string {
  return t(
    'settings.browser.sshWorkspaceRouting.rowDescription',
    'Where browser traffic leaves from. Pages always render on this device.'
  )
}
