import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getRemoteServerManualUpdateHelp } from './RemoteServerUpdateStatus'

export function getRemoteServerVersionDescription(
  entry: RemoteServerUpdateEntry,
  t: Translate = translate
): string {
  if (entry.currentVersion && entry.targetVersion && entry.currentVersion !== entry.targetVersion) {
    return `${entry.currentVersion} → ${entry.targetVersion}`
  }
  if (entry.currentVersion) {
    return `v${entry.currentVersion}`
  }
  return t(
    'auto.components.settings.RemoteServerUpdateDialog.versionUnavailable',
    'Version unavailable'
  )
}

export function getRemoteServerEntryHelp(
  entry: RemoteServerUpdateEntry,
  t: Translate = translate
): string | null {
  if (entry.error) {
    return entry.error
  }
  if (entry.phase === 'manual') {
    return getRemoteServerManualUpdateHelp(entry, t)
  }
  if (entry.phase === 'restarting') {
    return t(
      'auto.components.settings.RemoteServerUpdateDialog.restartingHelp',
      'Waiting for the replacement server to reconnect on the new version.'
    )
  }
  return null
}
