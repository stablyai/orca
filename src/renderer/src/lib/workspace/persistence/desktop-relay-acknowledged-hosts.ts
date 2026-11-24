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

/** What the window knew when it built a write (window-side only, never sent). */
export type RelayWriteContext = {
  held: HeldRelayTabs
  /** Whether the window still routes saves to a host it left out of this write. */
  routes: (hostId: ExecutionHostId) => boolean
}

const NO_CONTEXT: RelayWriteContext = { held: () => new Set(), routes: () => false }

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
   *  keeping everything it named as removal evidence in case the window stays open. Call `invalidate`
   *  before building the replacement so its removals cover unanswered writes too. */
  replacedBy(write: DesktopRelayWrite): void {
    this.invalidate()
    for (const host of write.hosts) {
      this.markStale(host.hostId, host)
    }
  }

  /** Main may hold `sent`'s ids as well as the last accepted ones; a later removal may name either.
   *  `processed`: main applied the write (refusing some ids), so the ids it removed are gone for good. */
  private markStale(
    hostId: ExecutionHostId,
    sent: AcknowledgedHost,
    processed?: DesktopRelayWrite['hosts'][number]
  ): void {
    const last = processed?.complete ? undefined : this.hosts.get(hostId)
    const kept = { ...last?.relayIdsByTabId }
    for (const tabId of processed?.removedTabIds ?? []) {
      delete kept[tabId]
    }
    this.hosts.set(hostId, {
      complete: sent.complete,
      relayIdsByTabId: { ...kept, ...sent.relayIdsByTabId },
      stale: true
    })
  }

  /** Narrow a full write to unacknowledged hosts and changed ids; `acknowledge` records main's answer. */
  narrow(
    full: DesktopRelayWrite,
    { held, routes }: RelayWriteContext = NO_CONTEXT
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
    // A host this save leaves out (an incomplete host with no slice) resends a baseline when it next
    // goes, still naming the ids that ended meanwhile. One holding no ids, or that the window no longer
    // routes to, is dropped (its workspaces were removed, and main clears their ownership with them).
    for (const [hostId, host] of this.hosts) {
      if (wanted.has(hostId)) {
        continue
      }
      if (!hasEntries(host.relayIdsByTabId) || !routes(hostId)) {
        this.hosts.delete(hostId)
      } else if (!host.stale) {
        this.hosts.set(hostId, { ...host, stale: true })
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
      const refused = new Set(result.refused)
      for (const delta of hosts) {
        const { hostId } = delta
        const host = wanted.get(hostId)
        const last = this.hosts.get(hostId)
        if (host && accepted.has(hostId) && !refused.has(hostId)) {
          this.hosts.set(hostId, host)
        } else if (host) {
          // A refused write was applied except the refused ids; a skipped one may still be retried.
          this.markStale(hostId, host, refused.has(hostId) ? delta : undefined)
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

function hasEntries(record: Record<string, string>): boolean {
  for (const _ in record) {
    return true
  }
  return false
}
