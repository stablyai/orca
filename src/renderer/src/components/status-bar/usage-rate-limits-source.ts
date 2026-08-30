import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import {
  createPendingProviderSnapshot,
  hasUsageData,
  isProviderConfigured
} from './status-bar-provider-visibility'

/**
 * Which machine's usage the status-bar badges describe (#15798).
 *
 * With a remote Active Server the agents run there, so the badges must render
 * that server's numbers — the viewer's local poll describes a machine that runs
 * nothing and can look perfectly healthy while being wrong. Loss of contact is
 * its own verdict: per docs/reference/ssh-execution-boundary.md it may not be
 * collapsed into "still loading" or into a 0%/healthy bar.
 */
export type RemoteUsageState =
  | { kind: 'local' }
  /** A remote server owns usage and its first snapshot has not landed yet. */
  | { kind: 'remote-pending' }
  /** The owning server's usage cannot be verified, so no bar may claim numbers. */
  | {
      kind: 'remote-unverifiable'
      ownerLabel: string
      reason: RemoteUsageFailureReason
      /** Last snapshot that server vouched for, so its bars stay put instead of vanishing. */
      lastKnown?: RateLimitState | null
    }
  | { kind: 'remote'; rateLimits: RateLimitState }

/**
 * Why two reasons: a host that answers but publishes no usage is reachable, so
 * telling the user we "cannot reach" it would be false.
 */
export type RemoteUsageFailureReason = 'unreachable' | 'usage-not-published'

/**
 * Keys of RateLimitState that hold a provider snapshot. Derived rather than
 * listed so a newly added provider is a compile error in the maps below instead
 * of a silent leak of local numbers under a remote owner.
 */
type UsageProviderKey = {
  [K in keyof RateLimitState]-?: RateLimitState[K] extends ProviderRateLimits | null ? K : never
}[keyof RateLimitState]

const USAGE_PROVIDER_IDS: Record<UsageProviderKey, ProviderRateLimits['provider']> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencodeGo: 'opencode-go',
  kimi: 'kimi',
  antigravity: 'antigravity',
  minimax: 'minimax',
  grok: 'grok'
}

const USAGE_PROVIDER_KEYS = Object.keys(USAGE_PROVIDER_IDS) as UsageProviderKey[]

// Why: the host may predate a field the client now reads. RateLimitState types
// these as required, so read the remote copy through a Partial to keep the
// undefined branch reachable instead of letting a bar silently vanish.
type PartialRemoteRateLimitState = Partial<RateLimitState>

function replaceProviders(
  build: (providerId: ProviderRateLimits['provider']) => ProviderRateLimits
): Pick<RateLimitState, UsageProviderKey> {
  const replaced = {} as Pick<RateLimitState, UsageProviderKey>
  for (const key of USAGE_PROVIDER_KEYS) {
    replaced[key] = build(USAGE_PROVIDER_IDS[key])
  }
  return replaced
}

function describeUnverifiableOwner(ownerLabel: string, reason: RemoteUsageFailureReason): string {
  return reason === 'usage-not-published'
    ? translate(
        'auto.components.status.bar.usage.remoteOwnerNoUsage',
        'Usage unavailable — {{server}} does not report usage',
        { server: ownerLabel }
      )
    : translate(
        'auto.components.status.bar.usage.remoteOwnerUnreachable',
        'Usage unavailable — cannot reach {{server}}',
        { server: ownerLabel }
      )
}

function createUnverifiableProviderSnapshot(
  providerId: ProviderRateLimits['provider'],
  message: string
): ProviderRateLimits {
  return {
    ...createPendingProviderSnapshot(providerId),
    error: message,
    // Why: the badge label is provider-classified copy; this flag keeps it from
    // reading "Refresh failed" for a failure no refresh can fix (#15798).
    usageMetadata: { unverifiableUsageOwner: true },
    status: 'error'
  }
}

/**
 * Blank every bar the owner can no longer vouch for, without inventing bars it
 * never had (#15804).
 *
 * Why the gate: a blank + unconfigured provider has no numbers to leak and is
 * no evidence anyone has it set up. Stamping it 'error' reads as "configured"
 * to `isProviderConfigured`, which would pin MiniMax/OpenCode Go bars on users
 * who never enabled them and suppress the usage setup CTA.
 */
function markProvidersUnverifiable(
  base: RateLimitState,
  message: string
): Pick<RateLimitState, UsageProviderKey> {
  const replaced = {} as Pick<RateLimitState, UsageProviderKey>
  for (const key of USAGE_PROVIDER_KEYS) {
    const provider = base[key]
    const blankAndUnconfigured =
      provider == null || (!isProviderConfigured(provider) && !hasUsageData(provider))
    replaced[key] = blankAndUnconfigured
      ? provider
      : createUnverifiableProviderSnapshot(USAGE_PROVIDER_IDS[key], message)
  }
  return replaced
}

function normalizeFlag(remoteValue: boolean | undefined, localValue: boolean): boolean {
  return typeof remoteValue === 'boolean' ? remoteValue : localValue
}

function adoptRemoteRateLimits(local: RateLimitState, remote: RateLimitState): RateLimitState {
  const partial = remote as PartialRemoteRateLimitState
  return {
    ...remote,
    // Why: MiniMax/Grok sign-in lives on disk, so a host older than those
    // providers omits the flags entirely; falling back to the local value keeps
    // a configured bar visible instead of making it disappear on the first
    // remote snapshot.
    minimaxCookieConfigured: normalizeFlag(
      partial.minimaxCookieConfigured,
      local.minimaxCookieConfigured
    ),
    grokAuthConfigured: normalizeFlag(partial.grokAuthConfigured, local.grokAuthConfigured),
    claudeTarget: partial.claudeTarget ?? local.claudeTarget,
    codexTarget: partial.codexTarget ?? local.codexTarget,
    inactiveClaudeAccounts: partial.inactiveClaudeAccounts ?? [],
    inactiveCodexAccounts: partial.inactiveCodexAccounts ?? []
  }
}

export function resolveStatusBarUsageRateLimits(
  localRateLimits: RateLimitState,
  remoteUsage: RemoteUsageState
): RateLimitState {
  if (remoteUsage.kind === 'local') {
    return localRateLimits
  }
  if (remoteUsage.kind === 'remote') {
    return adoptRemoteRateLimits(localRateLimits, remoteUsage.rateLimits)
  }
  // Why: never keep a local window here. Rendering the viewer's percentages
  // under the server's name is the exact "looks correct, is wrong" failure
  // #15798 reports.
  if (remoteUsage.kind === 'remote-pending') {
    return { ...localRateLimits, ...replaceProviders(createPendingProviderSnapshot) }
  }
  // Why the lastKnown base: the bars the server vouched for keep their slots
  // carrying the verdict, instead of silently disappearing on a thin client
  // that has none of those providers configured locally.
  const base = remoteUsage.lastKnown ?? localRateLimits
  const providers = markProvidersUnverifiable(
    base,
    describeUnverifiableOwner(remoteUsage.ownerLabel, remoteUsage.reason)
  )
  return { ...localRateLimits, ...providers }
}

/** Newest provider snapshot timestamp in a state, or 0 when nothing has landed. */
export function latestUsageUpdatedAt(rateLimits: RateLimitState | null): number {
  if (!rateLimits) {
    return 0
  }
  let newest = 0
  for (const key of USAGE_PROVIDER_KEYS) {
    const provider = rateLimits[key]
    if (provider && provider.updatedAt > newest) {
      newest = provider.updatedAt
    }
  }
  return newest
}
