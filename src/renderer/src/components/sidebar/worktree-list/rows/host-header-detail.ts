import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { translateExecutionHostDetail } from '../../execution-host-label'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'

export function getHostHeaderDetail(
  row: Pick<
    HostHeaderRow,
    'health' | 'blockedReason' | 'vmState' | 'connectionStatus' | 'kind' | 'detail'
  >,
  t: Translate = translate
): { text: string; isWarning: boolean } | null {
  // A VM's lifecycle names the state; suspended is intentional, so only failures warn.
  if (row.vmState === 'provision_failed') {
    return {
      text: t('auto.components.sidebar.WorktreeList.hostVmSetupFailed', 'Setup failed'),
      isWarning: true
    }
  }
  if (row.vmState === 'resume_failed') {
    return {
      text: t('auto.components.sidebar.WorktreeList.hostVmResumeFailed', 'Resume failed'),
      isWarning: true
    }
  }
  if (row.health === 'suspended') {
    return {
      text: t('auto.components.sidebar.WorktreeList.hostVmSuspended', 'Suspended'),
      isWarning: false
    }
  }
  if (row.health === 'waking') {
    return {
      text: t('auto.components.sidebar.WorktreeList.hostVmWaking', 'Waking…'),
      isWarning: false
    }
  }
  if (row.health === 'provisioning') {
    return {
      text: t('auto.components.sidebar.WorktreeList.hostVmProvisioning', 'Provisioning…'),
      isWarning: false
    }
  }
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
    return { text: translateExecutionHostDetail(row.detail), isWarning: false }
  }
  return null
}
