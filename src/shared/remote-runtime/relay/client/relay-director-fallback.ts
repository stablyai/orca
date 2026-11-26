import { RelayOuterError } from './relay-e2ee-link'
import { PairedE2EEAuthenticationError } from './paired-e2ee-v2-physical-channel'
import type { RelayHostOfflineStreak } from './relay-host-offline-streak'
import type { MobileRelayEndpoint } from '../mobile-relay-credential-contract'

type RelayDialResult = { ok: true } | { ok: false; error: Error }

// Local aborts provide no cell-assignment evidence, so do not consume a director resolution attempt.
export class RelayDialAbortedError extends Error {
  constructor() {
    super('relay dial aborted before opening a session')
  }
}

// After a director-class failure, resolve/persist the assignment and retry this credential once.
export async function dialRelayThroughDirectorFallback(args: {
  resumeToken: string
  hostOfflineStreak?: RelayHostOfflineStreak
  relay: () => MobileRelayEndpoint
  dial: () => Promise<RelayDialResult>
  resolveRelay: (input: {
    relay: MobileRelayEndpoint
    resumeToken: string
  }) => Promise<MobileRelayEndpoint>
  persistResolvedRelay: (resolved: MobileRelayEndpoint) => Promise<void>
  /** Which failures the director may fix; a client adds its own (the phone: a quiet cell). */
  isResolutionFailure?: (error: Error) => boolean
}): Promise<RelayDialResult> {
  const first = await args.dial()
  const relay = args.relay()
  const persistentHostOffline =
    args.hostOfflineStreak?.shouldResolve(first.ok ? null : first.error) ?? false
  if (
    first.ok ||
    first.error instanceof RelayDialAbortedError ||
    !(
      persistentHostOffline ||
      (args.isResolutionFailure ?? isDirectorResolutionFailure)(first.error)
    )
  ) {
    return first
  }
  try {
    const resolved = await args.resolveRelay({ relay, resumeToken: args.resumeToken })
    // A 4404 from the cell the director still names is the desktop being offline, not a move:
    // keep the normal host-offline wait instead of redialing at once.
    const unchanged =
      resolved.cellUrl === relay.cellUrl && resolved.assignmentEpoch === relay.assignmentEpoch
    if (persistentHostOffline && unchanged) {
      return first
    }
    await args.persistResolvedRelay(resolved)
    return await args.dial()
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

/** Failures a fresh cell assignment may fix: a wrong or draining cell, or a socket that died. */
export function isDirectorResolutionFailure(error: Error): boolean {
  return (
    !(error instanceof PairedE2EEAuthenticationError) &&
    (!(error instanceof RelayOuterError) || [4409, 4503, 1006].includes(error.code))
  )
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
