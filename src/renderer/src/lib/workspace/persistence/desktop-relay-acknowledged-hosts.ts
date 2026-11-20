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
  // Writes sent but not yet answered: main may have stored them, so they count as removal evidence.
  private inFlight = new Set<ReadonlyMap<ExecutionHostId, AcknowledgedHost>>()

  forget(): void {
    this.hosts = new Map()
    this.inFlight = new Set()
    this.generation += 1
  }

  /** Every host resends a baseline, and late answers are ignored. Ids main may hold from this window
   *  (accepted, or sent and unanswered) stay as removal evidence. */
  invalidate(): void {
    for (const [hostId, host] of this.hosts) {
      this.hosts.set(hostId, { ...host, stale: true })
    }
    for (const sent of this.inFlight) {
      for (const [hostId, host] of sent) {
        this.markStale(hostId, host)
      }
    }
    this.inFlight = new Set()
    this.generation += 1
  }

  /** A full replacement (quit, unload) was written without an answer: resend baselines afterwards,
   *  keeping everything it named as removal evidence in case the window stays open. */
  replacedBy(write: DesktopRelayWrite): void {
    this.invalidate()
    for (const host of write.hosts) {
      this.markStale(host.hostId, host)
    }
  }

  /** Main may hold `sent`'s ids as well as the last accepted ones; a later removal may name either. */
  private markStale(hostId: ExecutionHostId, sent: AcknowledgedHost): void {
    const last = this.hosts.get(hostId)
    this.hosts.set(hostId, {
      complete: sent.complete,
      relayIdsByTabId: { ...last?.relayIdsByTabId, ...sent.relayIdsByTabId },
      stale: true
    })
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
    const sent = new Map(
      hosts.flatMap(({ hostId }) => {
        const host = wanted.get(hostId)
        return host ? [[hostId, host] as const] : []
      })
    )
    // A write with no hosts is never sent, so it is never answered.
    if (sent.size > 0) {
      this.inFlight.add(sent)
    }
    const acknowledge = (result: DesktopRelayWriteResult) => {
      if (generation !== this.generation) {
        return
      }
      this.inFlight.delete(sent)
      const accepted = new Set([...result.applied, ...result.unchanged])
      for (const hostId of result.refused) {
        accepted.delete(hostId)
      }
      for (const { hostId } of hosts) {
        const host = wanted.get(hostId)
        const last = this.hosts.get(hostId)
        if (host && accepted.has(hostId)) {
          this.hosts.set(hostId, host)
        } else if (host) {
          // Refused writes are partly applied, and skipped ones may be retried: keep both as evidence.
          this.markStale(hostId, host)
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
