import { translate } from '@/i18n/i18n'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/host-section-rows'

export function getHostHeaderDetail(
  row: Pick<HostHeaderRow, 'health' | 'blockedReason' | 'connectionStatus' | 'kind' | 'detail'>
): { text: string; isWarning: boolean } | null {
  // Revoked pairing requires a new link rather than a host update.
  if (row.health === 'blocked' && row.blockedReason === 'access-revoked') {
    return {
      text: translate(
        'auto.components.sidebar.WorktreeList.hostRepairRequired',
        'Re-pair required'
      ),
      isWarning: true
    }
  }
  // Warn compactly when compatibility blocks a host.
  if (row.health === 'blocked') {
    return {
      text: translate('auto.components.sidebar.WorktreeList.7a8b9c0d1e', 'Update required'),
      isWarning: true
    }
  }
  // Name authentication failure because the health icon cannot explain how to recover.
  if (row.connectionStatus === 'auth-failed') {
    return {
      text: translate(
        'auto.components.sidebar.WorktreeList.hostAuthNeeded',
        'Authentication needed'
      ),
      isWarning: true
    }
  }
  if (row.health === 'disconnected') {
    return {
      text: translate('auto.components.sidebar.WorktreeList.hostDisconnected', 'Disconnected'),
      isWarning: false
    }
  }
  // Transport details add context only for remote hosts.
  if (row.kind !== 'local') {
    return { text: row.detail, isWarning: false }
  }
  return null
}
