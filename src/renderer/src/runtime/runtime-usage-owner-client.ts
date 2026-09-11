import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { OwnedRateLimitsReading } from '../../../shared/rate-limit-owner-usage'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { runtimeTargetForExecutionHostId } from './runtime-client-target'
import {
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from './runtime-provider-accounts-client'

// Why: usage reads follow the execution owner. There is no new RPC here — a
// paired runtime already publishes its whole RateLimitState on every
// accounts.subscribe snapshot, and accounts.list({refreshUsage:true}) already
// runs the same refresh the desktop's own manual refresh does.

// Why: a manual refresh forces a provider fetch per account on the host; the
// accounts pane uses the same allowance for the same call.
const OWNED_USAGE_REFRESH_TIMEOUT_MS = 30_000

export type OwnedRateLimitsWatcher = { close: () => void }

function unsupportedHost(hostLabel: string): OwnedRateLimitsReading {
  return {
    kind: 'unavailable',
    unavailable: {
      reason: 'unsupported-host',
      message: `${hostLabel} does not report provider usage. Update the remote Orca server to see it here.`
    }
  }
}

// Why: the owner already answered once. Losing the link observes nothing about
// its quota, so the last reading stands and is marked as no longer confirmed —
// `unverifiable`, not a wipe and not this machine's numbers.
function contactLost(hostLabel: string): OwnedRateLimitsReading {
  return {
    kind: 'contact-lost',
    message: `Lost contact with ${hostLabel}. Showing the last usage it reported.`
  }
}

function unreachableHost(hostLabel: string, cause: unknown): OwnedRateLimitsReading {
  return {
    kind: 'unavailable',
    unavailable: {
      reason: 'unreachable-host',
      message: `Could not read provider usage from ${hostLabel}: ${String((cause as Error)?.message ?? cause)}`
    }
  }
}

// Absence and null are both "this host told us nothing", and neither is a
// licence to show local usage — that would attribute this machine's numbers to
// the selected host. Only a host that predates the field can omit it.
export function readAccountsSnapshotUsage(
  snapshot: ProviderAccountsSnapshot,
  hostLabel: string
): OwnedRateLimitsReading {
  if (!snapshot.rateLimits) {
    return unsupportedHost(hostLabel)
  }
  return {
    kind: 'usage',
    state: snapshot.rateLimits,
    claudeAccountId: snapshot.claude?.activeAccountId ?? null,
    codexAccountId: snapshot.codex?.activeAccountId ?? null
  }
}

function localReading(state: RateLimitState): OwnedRateLimitsReading {
  // The desktop's own usage carries no remote account attribution; the local
  // services already scope it to the active local account.
  return { kind: 'usage', state, claudeAccountId: null, codexAccountId: null }
}

/**
 * Live usage for one owner. Local usage arrives on the desktop IPC push instead,
 * so only a paired runtime is watched here.
 */
export function watchOwnedRateLimits(
  hostId: ExecutionHostId,
  hostLabel: string,
  onReading: (reading: OwnedRateLimitsReading) => void
): OwnedRateLimitsWatcher {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'runtime') {
    return { close: () => {} }
  }
  let answered = false
  const watcher = watchProviderAccounts(
    { activeRuntimeEnvironmentId: parsed.environmentId },
    {
      onSnapshot: (snapshot) => {
        answered = true
        onReading(readAccountsSnapshotUsage(snapshot, hostLabel))
      },
      // Losing contact with the owner is never evidence about its usage, and
      // never a reason to show this machine's. Before the owner has answered
      // there is nothing to keep, so say the usage is unavailable; afterwards
      // keep what it reported and mark it unconfirmed.
      onError: (error) =>
        onReading(answered ? contactLost(hostLabel) : unreachableHost(hostLabel, error)),
      onContactLost: () => onReading(contactLost(hostLabel)),
      // Why: this stream lives for the app, not a pane. Elapsed time observes
      // nothing about the host — only the subscription erroring or closing
      // does, and both already arrive on onError.
      firstSnapshotTimeoutMs: null
    }
  )
  return { close: watcher.close }
}

/** Reads the owner's current usage without forcing a provider refresh. */
export async function readOwnedRateLimits(
  hostId: ExecutionHostId,
  hostLabel: string
): Promise<OwnedRateLimitsReading> {
  return requestOwnedRateLimits(hostId, hostLabel, false)
}

/** Forces the owner to refresh every provider, then reads the result. */
export async function refreshOwnedRateLimits(
  hostId: ExecutionHostId,
  hostLabel: string
): Promise<OwnedRateLimitsReading> {
  return requestOwnedRateLimits(hostId, hostLabel, true)
}

async function requestOwnedRateLimits(
  hostId: ExecutionHostId,
  hostLabel: string,
  refreshUsage: boolean
): Promise<OwnedRateLimitsReading> {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    const state = refreshUsage
      ? await window.api.rateLimits.refresh()
      : await window.api.rateLimits.get()
    return localReading(state as RateLimitState)
  }
  const target = runtimeTargetForExecutionHostId(hostId)
  if (!target || target.kind === 'local') {
    // A direct-SSH host is not dispatchable for this client path. Answering
    // locally would report the wrong machine's accounts.
    return unsupportedHost(hostLabel)
  }
  try {
    const snapshot = await callRuntimeRpc<ProviderAccountsSnapshot>(
      target,
      'accounts.list',
      { refreshUsage },
      { timeoutMs: OWNED_USAGE_REFRESH_TIMEOUT_MS }
    )
    return readAccountsSnapshotUsage(snapshot, hostLabel)
  } catch (error) {
    return unreachableHost(hostLabel, error)
  }
}
