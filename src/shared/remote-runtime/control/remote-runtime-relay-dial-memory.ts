import { unrefTimer } from '../../timers/unref-timer'
import type { SharedHostLinkEntry } from '../relay/client/shared-host-relay-link'
import {
  isHostAttachTimeout,
  RelayHostOfflineStreak
} from '../relay/client/relay-host-offline-streak'
import { RelayOuterError } from '../relay/client/relay-e2ee-link'
import { MOBILE_RELAY_CLOSE_CODE } from '../relay/mobile-relay-close-codes'
import {
  RELAY_DIRECTOR_RETRY_AFTER_MAX_MS,
  RelayDirectorHttpError,
  relayDirectorRetryAfterMs,
  resolveRelayEndpoint
} from '../relay/client/relay-director-resolve'
import {
  dialRelayThroughDirectorFallback,
  RelayDialAbortedError
} from '../relay/client/relay-director-fallback'
import { PairedE2EEAuthenticationError } from '../relay/client/paired-e2ee-v2-physical-channel'
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
  private hostOfflineDials = 0
  private heldUntil = 0
  private readonly holdWaiters = new Set<() => void>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {}

  /**
   * A host offline (4404) holds the next dial: 1.5 s, doubling to a 15 s cap, jittered down to
   * half so a fleet doesn't redial in step. The phone retries an offline host jittered within 15 s
   * (mobile-relay-retry-delays.ts:6-7, 25-30) and superset's active pane caps at 10 s
   * (terminal-ws-transport.ts:232-233). An attach timeout means the host was seated: no hold.
   */
  noteDialFailed(error: Error): void {
    if (
      !(error instanceof RelayOuterError) ||
      error.code !== MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE ||
      isHostAttachTimeout(error)
    ) {
      return
    }
    this.hostOfflineDials += 1
    const capMs = Math.min(
      HOST_OFFLINE_HOLD_MIN_MS * 2 ** (this.hostOfflineDials - 1),
      HOST_OFFLINE_HOLD_MAX_MS
    )
    this.extendHold(this.hostOfflineDials === 1 ? capMs : capMs * (0.5 + 0.5 * this.random()))
  }

  /** The director asked for a pause (Retry-After): no dial before it, capped as the phone caps it. */
  noteRetryAfter(retryAfterMs: number): void {
    if (retryAfterMs > 0) {
      this.extendHold(Math.min(retryAfterMs, RELAY_DIRECTOR_RETRY_AFTER_MAX_MS))
    }
  }

  /**
   * After the first 4404 of an episode (which told every caller the host is offline), a failed
   * dial that isn't a verdict on the credential redials inside the same channel when its hold
   * ends: one timer, as the phone's reconnect controller keeps (mobile-relay-reconnect-controller.ts:229-232),
   * not the connection's own backoff stacked on the hold.
   */
  redialsWithinOfflineEpisode(error: Error): boolean {
    return (
      this.hostOfflineDials > 1 &&
      // Only while a hold paces it: any other failure (a dropped network) ends the channel.
      this.heldUntil > this.now() &&
      !(error instanceof RelayDialAbortedError) &&
      !relayCredentialRefused(error) &&
      !(error instanceof PairedE2EEAuthenticationError)
    )
  }

  noteConnected(): void {
    this.lastConnectedAt = this.now()
    this.hostOfflineDials = 0
    this.heldUntil = 0
  }

  /**
   * Explicit Connect, or the OS or network coming back: dial now, as the phone's foreground reset
   * (mobile-relay-reconnect-controller.ts:64-98), superset's reconnect() (relaySocket.ts:150-154)
   * and paseo's ensureConnected (daemon-client.ts:1855-1874) do. A held dial goes out at once.
   */
  clearHold(): void {
    this.hostOfflineDials = 0
    this.heldUntil = 0
    for (const release of this.holdWaiters) {
      release()
    }
  }

  /**
   * Runs `dial` now, or once the hold ends: the one timer a held dial waits on, so callers and
   * scheduled retries that open meanwhile wait with it instead of each dialing or being refused.
   */
  afterHold(dial: () => void): () => void {
    const waitMs = this.heldUntil - this.now()
    if (waitMs <= 0) {
      dial()
      return () => {}
    }
    const release = (): void => {
      clearTimeout(timer)
      this.holdWaiters.delete(release)
      dial()
    }
    const timer = setTimeout(release, waitMs)
    unrefTimer(timer)
    this.holdWaiters.add(release)
    return () => {
      clearTimeout(timer)
      this.holdWaiters.delete(release)
    }
  }

  private extendHold(holdMs: number): void {
    this.heldUntil = Math.max(this.heldUntil, this.now() + Math.floor(holdMs))
  }
}

const HOST_OFFLINE_HOLD_MIN_MS = 1_500
const HOST_OFFLINE_HOLD_MAX_MS = 15_000

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

/** Dials a host's Relay link, redialing within an offline episode until it connects or ends. */
export async function dialRelayRuntimeLink(args: {
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
  /** Before each redial within an offline episode: the channel is connecting again. */
  beforeRedial: () => void
}): Promise<{ ok: true } | { ok: false; error: Error }> {
  for (;;) {
    const result = await dialThroughDirector(args)
    if (!result.ok) {
      // Before deciding to redial: a director's pause holds the redial too.
      args.memory.noteRetryAfter(relayDirectorRetryAfterMs(result.error))
    }
    if (result.ok || !args.memory.redialsWithinOfflineEpisode(result.error)) {
      return result
    }
    args.beforeRedial()
  }
}

/**
 * One dial as the phone makes it: a wrong, draining or dead cell (4409, 4503, 1006), or a host
 * offline for a while, asks the director where the host is now, then redials once. An invite has
 * no resume token to ask with; an older pairing doesn't name its director.
 */
function dialThroughDirector(
  args: Parameters<typeof dialRelayRuntimeLink>[0]
): Promise<{ ok: true } | { ok: false; error: Error }> {
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
