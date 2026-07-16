import { translate } from '@/i18n/i18n'

// Why: translators need complete count variants; English suffixes cannot be
// reordered or declined in other languages.
export function getSyncedSshServerSummary(count: number): string {
  return count === 1
    ? translate('auto.components.settings.SshPane.syncedOneServer', 'Synced {{count}} server', {
        count
      })
    : translate('auto.components.settings.SshPane.syncedManyServers', 'Synced {{count}} servers', {
        count
      })
}

export function getSyncedSshHostSummary(count: number): string {
  return count === 1
    ? translate(
        'auto.components.sidebar.AddRemoteHostDialog.sshImportSyncedOneHost',
        'Synced {{count}} host.',
        { count }
      )
    : translate(
        'auto.components.sidebar.AddRemoteHostDialog.sshImportSyncedManyHosts',
        'Synced {{count}} hosts.',
        { count }
      )
}
