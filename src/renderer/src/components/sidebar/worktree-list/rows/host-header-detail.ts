import { translate } from '@/i18n/i18n'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/host-section-rows'

export function getHostHeaderDetail(
  row: Pick<HostHeaderRow, 'health' | 'blockedReason' | 'connectionStatus' | 'kind' | 'detail'>
): { text: string; isWarning: boolean } | null {
  // Why: a host that revoked this client's pairing needs a new link, not an update.
  if (row.health === 'blocked' && row.blockedReason === 'access-revoked') {
    return {
      text: translate(
        'auto.components.sidebar.WorktreeList.hostRepairRequired',
        'Re-pair required'
      ),
      isWarning: true
    }
  }
  // Why: a blocked compatibility verdict earns a compact warning so the host stands out.
  if (row.health === 'blocked') {
    return {
      text: translate('auto.components.sidebar.WorktreeList.7a8b9c0d1e', 'Update required'),
      isWarning: true
    }
  }
  // Why: auth-failed needs a worded status; the health icon alone doesn't tell the user to re-auth.
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
  // Why: show the transport detail only for remote hosts; it's noise under the local label.
  if (row.kind !== 'local') {
    return { text: row.detail, isWarning: false }
  }
  return null
}
