import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/host-section-rows'

export function getHostHeaderDetail(
  row: Pick<HostHeaderRow, 'health' | 'blockedReason' | 'connectionStatus' | 'kind' | 'detail'>,
  t: Translate = translate
): { text: string; isWarning: boolean } | null {
  // Revoked pairing requires a new link rather than a host update.
  if (row.health === 'blocked' && row.blockedReason === 'access-revoked') {
    return {
      text: t('auto.components.sidebar.WorktreeList.hostRepairRequired', 'Re-pair required'),
      isWarning: true
    }
  }
  if (row.health === 'blocked' && row.blockedReason === 'server-replaced') {
    return {
      text: t(
        'auto.components.sidebar.WorktreeList.hostServerReplaced',
        'Different server: forget it, then connect'
      ),
      isWarning: true
    }
  }
  // Warn compactly when compatibility blocks a host.
  if (row.health === 'blocked') {
    return {
      text: t('auto.components.sidebar.WorktreeList.7a8b9c0d1e', 'Update required'),
      isWarning: true
    }
  }
  // Name authentication failure because the health icon cannot explain how to recover.
  if (row.connectionStatus === 'auth-failed') {
    return {
      text: t('auto.components.sidebar.WorktreeList.hostAuthNeeded', 'Authentication needed'),
      isWarning: true
    }
  }
  if (row.health === 'disconnected') {
    return {
      text: t('auto.components.sidebar.WorktreeList.hostDisconnected', 'Disconnected'),
      isWarning: false
    }
  }
  // Transport details add context only for remote hosts.
  if (row.kind !== 'local') {
    return { text: row.detail, isWarning: false }
  }
  return null
}
