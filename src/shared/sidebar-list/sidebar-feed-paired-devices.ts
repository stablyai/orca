import { parseExecutionHostId } from '../execution-host'
import type { SidebarFeedDomains } from './sidebar-feed-domains'

export function getPairedDeviceIdsByEnvironment(
  domains: SidebarFeedDomains
): ReadonlyMap<string, string> {
  const pairedDeviceIds = new Map<string, string>()
  for (const [hostId, { host }] of domains.pairedServerHosts) {
    const environmentId = parseExecutionHostId(hostId)
    if (environmentId?.kind === 'runtime' && host?.pairedDeviceId) {
      pairedDeviceIds.set(environmentId.environmentId, host.pairedDeviceId)
    }
  }
  return pairedDeviceIds
}
