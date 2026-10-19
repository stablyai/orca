import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { translate } from '@/i18n/i18n'
import {
  createPendingProviderSnapshot,
  hasUsageData,
  isProviderConfigured
} from './status-bar-provider-visibility'

/** Whose usage the status bar shows: this device, or the remote host that owns the accounts. */
export type OwnerUsageState =
  | { kind: 'local' }
  /** A remote host owns usage and has not answered yet. */
  | { kind: 'remote-pending' }
  | { kind: 'remote'; rateLimits: RateLimitState }
  /** The owning host's usage cannot be verified; no bar may claim numbers. */
  | {
      kind: 'remote-unverifiable'
      ownerLabel: string
      reason: OwnerUsageFailureReason
      /** Last snapshot that host vouched for, so its bars keep their slots. */
      lastKnown: RateLimitState | null
    }

/** A host that answers without usage is reachable, so "cannot reach" would be false. */
export type OwnerUsageFailureReason = 'unreachable' | 'usage-not-published'

type UsageProviderKey = {
  [K in keyof RateLimitState]-?: RateLimitState[K] extends ProviderRateLimits | null ? K : never
}[keyof RateLimitState]

// Why a Record: a new provider is a compile error here, not a silent leak of local numbers.
const USAGE_PROVIDER_IDS: Record<UsageProviderKey, ProviderRateLimits['provider']> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencodeGo: 'opencode-go',
  kimi: 'kimi',
  antigravity: 'antigravity',
  minimax: 'minimax',
  grok: 'grok',
  cursor: 'cursor',
  zcode: 'zcode'
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the keys of a Record<UsageProviderKey, …>.
const USAGE_PROVIDER_KEYS = Object.keys(USAGE_PROVIDER_IDS) as UsageProviderKey[]

function mapProviders(
  build: (key: UsageProviderKey) => ProviderRateLimits | null
): Pick<RateLimitState, UsageProviderKey> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one entry per UsageProviderKey.
  return Object.fromEntries(USAGE_PROVIDER_KEYS.map((key) => [key, build(key)])) as Pick<
    RateLimitState,
    UsageProviderKey
  >
}

function describeUnverifiableOwner(ownerLabel: string, reason: OwnerUsageFailureReason): string {
  return reason === 'usage-not-published'
    ? translate(
        'auto.components.status.bar.tooltip.remoteOwnerNoUsage',
        'Usage unavailable — {{server}} does not report usage. Update Orca on that host.',
        { server: ownerLabel }
      )
    : translate(
        'auto.components.status.bar.tooltip.remoteOwnerUnreachable',
        'Usage unavailable — cannot reach {{server}}',
        { server: ownerLabel }
      )
}

function adoptRemoteRateLimits(remote: RateLimitState): RateLimitState {
  // Why: an older host omits newer providers and flags; read through a Partial so those
  // become "not configured" on that host rather than undefined or the viewer's own values.
  const partial: Partial<RateLimitState> = remote
  return {
    ...remote,
    ...mapProviders((key) => partial[key] ?? null),
    minimaxCookieConfigured: partial.minimaxCookieConfigured === true,
    minimaxApiKeyConfigured: partial.minimaxApiKeyConfigured === true,
    opencodeGoApiKeyConfigured: partial.opencodeGoApiKeyConfigured === true,
    grokAuthConfigured: partial.grokAuthConfigured === true,
    cursorAuthConfigured: partial.cursorAuthConfigured === true,
    zcodePlanApiKeyConfigured: partial.zcodePlanApiKeyConfigured === true,
    claudeTarget: partial.claudeTarget ?? { runtime: 'host', wslDistro: null },
    codexTarget: partial.codexTarget ?? { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: partial.inactiveClaudeAccounts ?? [],
    inactiveCodexAccounts: partial.inactiveCodexAccounts ?? []
  }
}

// Why: an older host publishes no usage at all; its account services always cover these.
const ACCOUNT_OWNED_PROVIDERS: ReadonlySet<UsageProviderKey> = new Set(['claude', 'codex'])

export function resolveOwnerUsageRateLimits(
  local: RateLimitState,
  owner: OwnerUsageState
): RateLimitState {
  if (owner.kind === 'local') {
    return local
  }
  if (owner.kind === 'remote') {
    return adoptRemoteRateLimits(owner.rateLimits)
  }
  // Why: nothing of the viewer's (numbers or setup flags) may stand in for the remote host.
  if (owner.kind === 'remote-pending') {
    return createEmptyRateLimitState(
      mapProviders((key) => createPendingProviderSnapshot(USAGE_PROVIDER_IDS[key]))
    )
  }
  const message = describeUnverifiableOwner(owner.ownerLabel, owner.reason)
  const base = owner.lastKnown ? adoptRemoteRateLimits(owner.lastKnown) : null
  const stamp = (key: UsageProviderKey): ProviderRateLimits => ({
    ...createPendingProviderSnapshot(USAGE_PROVIDER_IDS[key]),
    error: message,
    usageMetadata: { unverifiableOwner: true },
    status: 'error'
  })
  if (!base) {
    return createEmptyRateLimitState(
      mapProviders((key) => (ACCOUNT_OWNED_PROVIDERS.has(key) ? stamp(key) : null))
    )
  }
  return {
    ...base,
    ...mapProviders((key) => {
      const provider = base[key]
      // Why: stamping a slot the host reported unconfigured would invent a bar it never had;
      // a still-fetching slot was real and must not keep loading through the outage.
      if (
        !provider ||
        (provider.status !== 'fetching' &&
          !isProviderConfigured(provider) &&
          !hasUsageData(provider))
      ) {
        return provider
      }
      return stamp(key)
    })
  }
}
