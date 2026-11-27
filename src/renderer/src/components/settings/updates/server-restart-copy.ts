import type { Translate } from '@/i18n/use-translate'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'

/** Phases where a started update is still in flight for that server. */
export const UPDATING_PHASES = new Set<RemoteServerUpdateEntry['phase']>([
  'queued',
  'checking-update',
  'downloading',
  'restarting'
])

export function getSessionsMayDropLabel(t: Translate): string {
  return t('settings.about.servers.sessionsMayDrop', 'Sessions may drop')
}

/** The armed button's accessible name: the whole question, including the warning. */
export function getServerRestartQuestion(servers: RemoteServerUpdateEntry[], t: Translate): string {
  const question =
    servers.length === 1
      ? t('settings.about.servers.confirmOne', 'Restart {{name}}?', {
          name: servers[0].name
        })
      : t('settings.about.servers.confirmMany', 'Restart {{count}} servers?', {
          count: servers.length
        })
  return `${question} ${t('settings.about.servers.liveMayDrop', 'Live sessions may drop.')}`
}
