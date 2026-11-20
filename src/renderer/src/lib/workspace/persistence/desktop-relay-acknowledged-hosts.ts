import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type {
  DesktopRelayWrite,
  DesktopRelayWriteResult
} from '../../../../../shared/workspace-session/desktop-relay-write'

type AcknowledgedHost = {
  complete: boolean
  relayIdsByTabId: Record<string, string>
  /** Main may hold something else now (a skipped, refused or failed write): resend a baseline, but
   *  keep these ids so an incomplete host still names the ones that ended. */
  stale?: boolean
}

/** Tabs whose rows this window holds parked for a host: their relay ids may be live though unsent. */
export type HeldRelayTabs = (hostId: ExecutionHostId) => ReadonlySet<string>

const NO_HELD_TABS: HeldRelayTabs = () => new Set()

/** What main last accepted from this window, per host, so a save sends only the relay ids that
 *  changed. Any doubt (a failed, skipped or refused write, a full replacement) drops back to a baseline. */
export class AcknowledgedDesktopRelays {
  private hosts = new Map<ExecutionHostId, AcknowledgedHost>()
  private generation = 0

  forget(): void {
    this.hosts = new Map()
    this.generation += 1
  }

  /** Every host resends a baseline, and late answers are ignored; the ids stay as removal evidence. */
  invalidate(): void {
    for (const [hostId, host] of this.hosts) {
      this.hosts.set(hostId, { ...host, stale: true })
    }
    this.generation += 1
  }

  /** Narrow a full write to unacknowledged hosts and changed ids; `acknowledge` records main's answer. */
  narrow(
    full: DesktopRelayWrite,
    held: HeldRelayTabs = NO_HELD_TABS
  ): {
    write: DesktopRelayWrite
    acknowledge: (result: DesktopRelayWriteResult) => void
  } {
    const generation = this.generation
    const hosts: DesktopRelayWrite['hosts'] = []
    const wanted = new Map<ExecutionHostId, AcknowledgedHost>()
    for (const host of full.hosts) {
      wanted.set(host.hostId, { complete: host.complete, relayIdsByTabId: host.relayIdsByTabId })
      const delta = this.deltaFor(host, held)
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
        const last = this.hosts.get(hostId)
        if (host && accepted.has(hostId)) {
          this.hosts.set(hostId, host)
        } else if (last) {
          this.hosts.set(hostId, { ...last, stale: true })
        }
      }
    }
    return { write: { version: full.version, hosts }, acknowledge }
  }

  /** Ids main accepted from this window that an incomplete host's write now leaves out, except tabs
   *  parked there: they ended, and only an explicit removal clears them (an omission doesn't). */
  endedOnIncompleteHost(host: DesktopRelayWrite['hosts'][number], held: HeldRelayTabs): string[] {
    const last = this.hosts.get(host.hostId)
    if (!last || host.complete) {
      return []
    }
    const omitted = Object.keys(last.relayIdsByTabId).filter(
      (tabId) => !Object.hasOwn(host.relayIdsByTabId, tabId)
    )
    // Parked rows are indexed only when an id is actually missing.
    if (omitted.length === 0) {
      return omitted
    }
    const parked = held(host.hostId)
    return omitted.filter((tabId) => !parked.has(tabId))
  }

  private deltaFor(
    host: DesktopRelayWrite['hosts'][number],
    held: HeldRelayTabs
  ): DesktopRelayWrite['hosts'][number] | null {
    const last = this.hosts.get(host.hostId)
    if (!last) {
      return host
    }
    if (last.stale || last.complete !== host.complete) {
      const ended = this.endedOnIncompleteHost(host, held)
      return ended.length > 0 ? { ...host, removedTabIds: ended } : host
    }
    const relayIdsByTabId: Record<string, string> = {}
    for (const [tabId, relayId] of Object.entries(host.relayIdsByTabId)) {
      if (last.relayIdsByTabId[tabId] !== relayId) {
        relayIdsByTabId[tabId] = relayId
      }
    }
    const removedTabIds = host.complete
      ? Object.keys(last.relayIdsByTabId).filter(
          (tabId) => !Object.hasOwn(host.relayIdsByTabId, tabId)
        )
      : this.endedOnIncompleteHost(host, held)
    if (Object.keys(relayIdsByTabId).length === 0 && removedTabIds.length === 0) {
      return null
    }
    return { hostId: host.hostId, complete: host.complete, relayIdsByTabId, removedTabIds }
  }
}
