import type { SSH_MANAGED_SERVER_PHASES } from '../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** Users read "server" as someone else's machine; this says where Orca runs and what moves. */
export function sshHostServerReassurance(host: string, t: Translate = translate): string {
  return t(
    'auto.components.settings.sshHostServer.reassurance',
    'Runs on {{host}}, reached over your own SSH connection. Your code and files stay where they are. Only Orca’s list of projects, tabs and terminals moves to {{host}}.',
    { host }
  )
}

export function settingUpLabel(
  phase: (typeof SSH_MANAGED_SERVER_PHASES)[number],
  host: string,
  t: Translate = translate
): string {
  switch (phase) {
    case 'deploying':
      return t('auto.components.settings.sshHostServer.deploying', 'Setting up Orca on {{host}}…', {
        host
      })
    case 'converting':
      return t('auto.components.settings.sshHostServer.converting', 'Moving to Orca on {{host}}…', {
        host
      })
    case 'connecting':
      return t(
        'auto.components.settings.sshHostServer.connecting',
        'Connecting to Orca on {{host}}…',
        { host }
      )
    case 'updating':
      return t('auto.components.settings.sshHostServer.updating', 'Updating Orca on {{host}}…', {
        host
      })
    case 'starting':
      return t('auto.components.settings.sshHostServer.starting', 'Starting Orca on {{host}}…', {
        host
      })
  }
}
