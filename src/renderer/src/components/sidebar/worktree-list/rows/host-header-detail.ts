import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { vmStateToDot } from '@/components/host-row-icon'
import { cloudStateLabel } from '@/components/orca-cloud/cloud-state-copy'
import { translateExecutionHostDetail } from '../../execution-host-label'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/host-section-rows'

export function getHostHeaderDetail(
  row: Pick<
    HostHeaderRow,
    'health' | 'blockedReason' | 'vmState' | 'connectionStatus' | 'kind' | 'detail'
  >,
  t: Translate = translate,
  /** Orca Cloud hosts use the cloud glossary: Asleep, Waking, Couldn't wake, never "Suspended". */
  isOrcaCloud = false
): { text: string; isWarning: boolean } | null {
  if (isOrcaCloud) {
    // One header for every sandbox: its detail is the aggregate ("1 running · 1 asleep").
    if (!row.vmState) {
      return row.detail ? { text: row.detail, isWarning: false } : null
    }
    const dot = vmStateToDot(row.vmState)
    return { text: cloudStateLabel(dot, t), isWarning: dot === 'failed' || dot === 'wakeFailed' }
  }
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
