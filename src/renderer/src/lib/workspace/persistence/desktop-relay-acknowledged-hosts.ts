import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type {
  DesktopRelayWrite,
  DesktopRelayWriteResult
} from '../../../../../shared/workspace-session/desktop-relay-write'

type AcknowledgedHost = { complete: boolean; relayIdsByTabId: Record<string, string> }

/** What main last accepted from this window, per host, so a save sends only the relay ids that
 *  changed. Any doubt (a failed, skipped or refused write, a full replacement) drops back to a baseline. */
export class AcknowledgedDesktopRelays {
  private hosts = new Map<ExecutionHostId, AcknowledgedHost>()
  private generation = 0

  forget(): void {
    this.hosts = new Map()
    this.generation += 1
  }

  /** Narrow a full write to unacknowledged hosts and changed ids; `acknowledge` records main's answer. */
  narrow(full: DesktopRelayWrite): {
    write: DesktopRelayWrite
    acknowledge: (result: DesktopRelayWriteResult) => void
  } {
    const generation = this.generation
    const hosts: DesktopRelayWrite['hosts'] = []
    const wanted = new Map<ExecutionHostId, AcknowledgedHost>()
    for (const host of full.hosts) {
      wanted.set(host.hostId, { complete: host.complete, relayIdsByTabId: host.relayIdsByTabId })
      const delta = this.deltaFor(host)
      if (delta) {
        hosts.push(delta)
      }
    }
    // A host the window no longer writes (closed, re-adopted under a new id) starts again from a baseline.
    for (const hostId of this.hosts.keys()) {
      if (!wanted.has(hostId)) {
        this.hosts.delete(hostId)
      }
    }
    const acknowledge = (result: DesktopRelayWriteResult) => {
      if (generation !== this.generation) {
        return
      }
      const accepted = new Set([...result.applied, ...result.unchanged])
      for (const hostId of result.refused) {
        accepted.delete(hostId)
      }
      for (const { hostId } of hosts) {
        const host = wanted.get(hostId)
        if (host && accepted.has(hostId)) {
          this.hosts.set(hostId, host)
        } else {
          this.hosts.delete(hostId)
        }
      }
    }
    return { write: { version: full.version, hosts }, acknowledge }
  }

  private deltaFor(
    host: DesktopRelayWrite['hosts'][number]
  ): DesktopRelayWrite['hosts'][number] | null {
    const last = this.hosts.get(host.hostId)
    if (!last || last.complete !== host.complete) {
      return host
    }
    const relayIdsByTabId: Record<string, string> = {}
    for (const [tabId, relayId] of Object.entries(host.relayIdsByTabId)) {
      if (last.relayIdsByTabId[tabId] !== relayId) {
        relayIdsByTabId[tabId] = relayId
      }
    }
    // Only a complete host's omission means an id ended; an incomplete host leaves omitted ids alone.
    const removedTabIds = host.complete
      ? Object.keys(last.relayIdsByTabId).filter(
          (tabId) => !Object.hasOwn(host.relayIdsByTabId, tabId)
        )
      : []
    if (Object.keys(relayIdsByTabId).length === 0 && removedTabIds.length === 0) {
      return null
    }
    return { hostId: host.hostId, complete: host.complete, relayIdsByTabId, removedTabIds }
  }
}
