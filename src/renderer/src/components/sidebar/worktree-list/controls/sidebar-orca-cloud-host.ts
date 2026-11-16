import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import {
  ORCA_CLOUD_HOST_LABEL,
  isOrcaCloudRuntimeEnvironment
} from '../../../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SidebarHostOption } from './sidebar-host-options'

/**
 * Orca Cloud is one logical host. Each sandbox is its own runtime environment underneath, so
 * without this every sandbox drew its own "Orca Cloud" header and Hosts entry. The first
 * sandbox's row stands for all of them (aliasHostIds); the rest merge into it, so filters and
 * host sections treat every cloud workspace as the same host. The shown row carries an aggregate
 * state, never one sandbox's.
 */
export function collapseOrcaCloudHosts(
  hosts: SidebarHostOption[],
  runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name' | 'source'>[],
  t: Translate = translate
): SidebarHostOption[] {
  const cloudIds = new Set<ExecutionHostId>(
    runtimeEnvironments
      .filter((environment) => isOrcaCloudRuntimeEnvironment(environment))
      .map((environment) => toRuntimeExecutionHostId(environment.id.trim()))
  )
  const cloudHosts = hosts.filter((host) => cloudIds.has(host.id) && !host.mergedIntoHostId)
  if (cloudHosts.length === 0) {
    return hosts
  }
  const shown = cloudHosts[0]
  const asleep = cloudHosts.filter((host) => host.vmState === 'suspended').length
  const failed = cloudHosts.filter(
    (host) => host.vmState === 'resume_failed' || host.vmState === 'provision_failed'
  ).length
  const running = cloudHosts.length - asleep - failed
  const aliasIds = new Set(cloudHosts.slice(1).map((host) => host.id))
  return hosts.map((host): SidebarHostOption => {
    if (host.id === shown.id) {
      const { vmState: _vmState, ...rest } = host
      return {
        ...rest,
        label: ORCA_CLOUD_HOST_LABEL,
        detail: orcaCloudAggregateDetail(running, asleep, t),
        // Dimmed like a sleeping host only when nothing is running.
        health: running > 0 ? 'available' : 'suspended',
        orcaCloud: { running, asleep },
        aliasHostIds: [...(host.aliasHostIds ?? []), ...aliasIds]
      }
    }
    return aliasIds.has(host.id)
      ? { ...host, label: ORCA_CLOUD_HOST_LABEL, mergedIntoHostId: shown.id }
      : host
  })
}

/** "Asleep", "2 running", or "1 running · 1 asleep": the cloud host as a whole. */
export function orcaCloudAggregateDetail(running: number, asleep: number, t: Translate): string {
  if (running === 0 && asleep > 0) {
    return t('orcaCloudWorkspace.state.asleep', 'Asleep')
  }
  if (asleep === 0) {
    return t('auto.components.sidebar.orcaCloudHost.running', '{{count}} running', {
      count: running
    })
  }
  return t(
    'auto.components.sidebar.orcaCloudHost.runningAsleep',
    '{{running}} running · {{asleep}} asleep',
    { running, asleep }
  )
}
