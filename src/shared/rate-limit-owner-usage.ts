import type { ExecutionHostId } from './execution-host'
import { createEmptyRateLimitState } from './rate-limit-state-factory'
import type { ProviderRateLimits, RateLimitState } from './rate-limit-types'

// Why: usage belongs to the execution owner that produced it. Keying it by
// ExecutionHostId — the same identity every other execution-boundary read
// routes on — is what keeps host A's numbers from being shown for host B, and
// what keeps the same account id on two hosts distinct.

/**
 * Why the selected owner's usage cannot be shown. Neither value ever licenses
 * falling back to local usage: that would answer for a different account.
 */
export type RateLimitOwnerUnavailableReason =
  /** A paired runtime whose build never publishes usage on its accounts snapshot. */
  | 'unsupported-host'
  /** The owner could not be reached, or refused the read. */
  | 'unreachable-host'

export type RateLimitOwnerUnavailable = {
  reason: RateLimitOwnerUnavailableReason
  message: string
}

/**
 * Contact with an owner that had already answered was lost. Per the execution
 * boundary, that is `unverifiable`, not evidence the numbers changed — so the
 * last reading stays on screen and this says it is no longer being confirmed.
 */
export type RateLimitOwnerContactLost = {
  message: string
}

export type RateLimitOwnerUsage = {
  hostId: ExecutionHostId
  state: RateLimitState
  /** Active provider account ids observed alongside `state`; display attribution. */
  claudeAccountId: string | null
  codexAccountId: string | null
  /** null while this owner's usage is available. */
  unavailable: RateLimitOwnerUnavailable | null
  /** null while the owner is still confirming the reading above. */
  contactLost: RateLimitOwnerContactLost | null
  /** Bumped when this owner becomes active; a reply carrying an older value is stale. */
  generation: number
}

/** Result of reading one owner's usage, whether or not it could be obtained. */
export type OwnedRateLimitsReading =
  | {
      kind: 'usage'
      state: RateLimitState
      claudeAccountId: string | null
      codexAccountId: string | null
    }
  | { kind: 'unavailable'; unavailable: RateLimitOwnerUnavailable }
  /** The owner answered once and then went quiet; its last reading still stands. */
  | { kind: 'contact-lost'; message: string }

function unavailableProvider(
  provider: ProviderRateLimits['provider'],
  message: string
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: message,
    status: 'unavailable'
  }
}

// Why: an explicit 'unavailable' snapshot, not a null one. getVisibleUsageProvider
// synthesizes a perpetually 'fetching' bar for a null provider the LOCAL settings
// say is configured — a spinner that can never resolve, because the owner that
// would resolve it is not this machine.
export function createUnavailableRateLimitState(message: string): RateLimitState {
  return createEmptyRateLimitState({
    claude: unavailableProvider('claude', message),
    codex: unavailableProvider('codex', message),
    gemini: unavailableProvider('gemini', message),
    opencodeGo: unavailableProvider('opencode-go', message),
    kimi: unavailableProvider('kimi', message),
    antigravity: unavailableProvider('antigravity', message),
    minimax: unavailableProvider('minimax', message),
    grok: unavailableProvider('grok', message)
  })
}

export function createPendingRateLimitOwnerUsage(
  hostId: ExecutionHostId,
  generation: number
): RateLimitOwnerUsage {
  return {
    hostId,
    state: createEmptyRateLimitState(),
    claudeAccountId: null,
    codexAccountId: null,
    unavailable: null,
    contactLost: null,
    generation
  }
}

export function rateLimitOwnerUsageFromReading(
  hostId: ExecutionHostId,
  generation: number,
  reading: OwnedRateLimitsReading,
  previous: RateLimitOwnerUsage | undefined
): RateLimitOwnerUsage {
  if (reading.kind === 'contact-lost') {
    const last = previous ?? createPendingRateLimitOwnerUsage(hostId, generation)
    return {
      ...last,
      hostId,
      generation,
      contactLost: { message: reading.message }
    }
  }
  if (reading.kind === 'unavailable') {
    return {
      hostId,
      state: createUnavailableRateLimitState(reading.unavailable.message),
      claudeAccountId: null,
      codexAccountId: null,
      unavailable: reading.unavailable,
      contactLost: null,
      generation
    }
  }
  return {
    hostId,
    state: reading.state,
    claudeAccountId: reading.claudeAccountId,
    codexAccountId: reading.codexAccountId,
    unavailable: null,
    contactLost: null,
    generation
  }
}
