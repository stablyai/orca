import {
  getPRAutoRefreshCadenceForHost,
  setPRAutoRefreshCadenceForHost,
  type PRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'

// Why no store or RPC imports here: store slice code reads these; the reads and host-contact
// subscriptions that feed them live in remote-host-pr-auto-refresh-cadence-sync.ts.

/** The cadence of a paired host, as this client last learned it; Default until it answers. */
export function hostPRAutoRefreshCadence(environmentId: string | null): PRAutoRefreshCadence {
  return getPRAutoRefreshCadenceForHost(environmentId)
}

/** A value just read from or written to the host (Settings control, settings.get) is authoritative. */
export function rememberHostPRAutoRefreshCadence(environmentId: string, value: unknown): void {
  setPRAutoRefreshCadenceForHost(environmentId, value)
}

export function forgetHostPRAutoRefreshCadence(environmentId: string): void {
  setPRAutoRefreshCadenceForHost(environmentId, null)
}
