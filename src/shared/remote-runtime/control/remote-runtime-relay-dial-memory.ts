import type { SharedHostLinkEntry } from '../relay/client/shared-host-relay-link'
import { RelayHostOfflineStreak } from '../relay/client/relay-host-offline-streak'
import {
  RelayDirectorHttpError,
  resolveRelayEndpoint
} from '../relay/client/relay-director-resolve'
import { dialRelayThroughDirectorFallback } from '../relay/client/relay-director-fallback'
import { parseRuntimeRelayEndpoint } from '../pairing/runtime-relay-endpoint'
import { relayRefusedCredential } from '../relay/client/shared-host-relay-link'

/**
 * What a host's Relay link remembers across its dials, as the phone's establisher does: when it
 * last connected and its 4404 streak (when to ask the director whether the host moved), and the
 * cell assignment epoch the director last named.
 */
export class RelayRuntimeDialMemory {
  lastConnectedAt: number | null = null
  assignmentEpoch: number | null = null
  readonly hostOfflineStreak = new RelayHostOfflineStreak(() => this.lastConnectedAt)
}

/** Relay's verdict that this credential is gone: the cell refused it, or the director did (401). */
export function relayCredentialRefused(error: Error): boolean {
  return (
    relayRefusedCredential(error) ||
    (error instanceof RelayDirectorHttpError && error.status === 401)
  )
}

/** The entry with the host's cell the director named, for the next dial. */
export function withRelayCell(entry: SharedHostLinkEntry, cellUrl: string): SharedHostLinkEntry {
  if (entry.resume) {
    return { ...entry, resume: { ...entry.resume, relay: { ...entry.resume.relay, cellUrl } } }
  }
  return entry.offer
    ? { ...entry, offer: { ...entry.offer, relay: { ...entry.offer.relay, cellUrl } } }
    : entry
}

/**
 * Dials a host's Relay link as the phone does: a wrong, draining or dead cell (4409, 4503, 1006),
 * or a host offline for a while, asks the director where the host is now, then redials once. An
 * invite has no resume token to ask with; an older pairing doesn't name its director.
 */
export function dialRelayRuntimeLink(args: {
  endpoint: string
  resumeToken: string | null
  memory: RelayRuntimeDialMemory
  cell: () => { cellUrl: string; relayHostId: string }
  dialOnce: () => Promise<{ ok: true } | { ok: false; error: Error }>
  store: {
    entry: () => SharedHostLinkEntry | undefined
    save: (entry: SharedHostLinkEntry) => void
  }
  resolveRelay?: typeof resolveRelayEndpoint
}): Promise<{ ok: true } | { ok: false; error: Error }> {
  const reach = parseRuntimeRelayEndpoint(args.endpoint)
  const directorUrl = reach?.directorUrl
  if (!args.resumeToken || !directorUrl) {
    return args.dialOnce()
  }
  const { memory, cell, store } = args
  return dialRelayThroughDirectorFallback({
    resumeToken: args.resumeToken,
    hostOfflineStreak: memory.hostOfflineStreak,
    relay: () => ({
      v: 1,
      directorUrl,
      cellUrl: cell().cellUrl,
      assignmentEpoch: memory.assignmentEpoch ?? reach.assignmentEpoch ?? 0,
      relayHostId: cell().relayHostId,
      e2eeFraming: 2
    }),
    dial: args.dialOnce,
    resolveRelay: (input) => (args.resolveRelay ?? resolveRelayEndpoint)(input),
    persistResolvedRelay: async (resolved) => {
      memory.assignmentEpoch = resolved.assignmentEpoch
      const current = store.entry()
      if (current) {
        store.save(withRelayCell(current, resolved.cellUrl))
      }
    }
  })
}
