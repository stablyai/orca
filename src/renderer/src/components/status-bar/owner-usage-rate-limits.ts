import type {
  OwnerNotSetUpPlaceholder,
  ProviderRateLimits,
  RateLimitState,
  UsageRateLimitFailureKind,
  UsageRateLimitMetadata
} from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { translate } from '@/i18n/i18n'
import {
  createPendingProviderSnapshot,
  hasUsageData,
  hasUsageProviderSettingsForProvider,
  isProviderConfigured
} from './status-bar-provider-visibility'
import { describeOwnerNotSetUp } from './owner-not-set-up-copy'

/** Whose usage the status bar shows: this device, or the remote host that owns the accounts. */
export type OwnerUsageState =
  | { kind: 'local' }
  /** A remote host owns usage and has not answered yet. */
  | { kind: 'remote-pending' }
  | { kind: 'remote'; ownerLabel: string; rateLimits: RateLimitState }
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

/** Stands in for a provider this device has set up but the owning host has not; carries no numbers. */
export function isOwnerNotSetUpPlaceholder(provider: ProviderRateLimits): boolean {
  return provider.usageMetadata?.ownerNotSetUp !== undefined
}

function isSetUpHere(local: RateLimitState, key: UsageProviderKey): boolean {
  const provider = local[key]
  return (
    (provider != null && (isProviderConfigured(provider) || hasUsageData(provider))) ||
    hasUsageProviderSettingsForProvider(USAGE_PROVIDER_IDS[key], local)
  )
}

// Why: these credentials live in this device's safe storage, so the host cannot reuse them.
function isSignInSavedHereOnly(local: RateLimitState, key: UsageProviderKey): boolean {
  return key === 'minimax'
    ? local.minimaxApiKeyConfigured || local.minimaxCookieConfigured
    : key === 'zcode' && local.zcodePlanApiKeyConfigured === true
}

// Why an allow-list: a host also says `unavailable` for "set up, but no reading" (agy too old,
// a ZCode account switch mid-refresh); only these reasons mean the provider is not set up.
const NOT_SET_UP_FAILURE_KINDS: ReadonlySet<UsageRateLimitFailureKind> = new Set([
  'missing-credentials',
  'cli-unavailable'
])
// Why: these fetchers name every not-set-up answer, so a reasonless `unavailable` is not one.
const NOT_SET_UP_NEEDS_REASON: ReadonlySet<UsageProviderKey> = new Set([
  'minimax',
  'zcode',
  'cursor',
  'antigravity'
])

/**
 * Whether the host positively reports it has no such provider. Null only means the host has
 * not finished a fetch (or blanked a skipped one), so it never counts.
 */
function isMissingOnHost(remote: RateLimitState, key: UsageProviderKey): boolean {
  const provider = remote[key]
  if (provider?.status !== 'unavailable') {
    return false
  }
  const failureKind = provider.usageMetadata?.failureKind
  return (
    (failureKind ? NOT_SET_UP_FAILURE_KINDS.has(failureKind) : !NOT_SET_UP_NEEDS_REASON.has(key)) &&
    // Why: a signed-in Grok account with no quota is also `unavailable`; its flag is not.
    !hasUsageProviderSettingsForProvider(USAGE_PROVIDER_IDS[key], remote)
  )
}

// Why: the host reports Claude on API-key billing exactly like no Claude login, so this
// placeholder only says the host shows no usage, never that Claude is not set up there.
function isClaudeUnknownOnHost(remote: RateLimitState): boolean {
  return (
    remote.claude?.status === 'unavailable' &&
    remote.claude.usageMetadata?.failureKind === 'missing-credentials'
  )
}

function describePlaceholder(
  local: RateLimitState,
  remote: RateLimitState,
  key: UsageProviderKey,
  ownerLabel: string
): OwnerNotSetUpPlaceholder | null {
  if (!isSetUpHere(local, key)) {
    return null
  }
  if (key === 'claude') {
    return isClaudeUnknownOnHost(remote) ? { kind: 'claude-unknown', ownerLabel } : null
  }
  return isMissingOnHost(remote, key)
    ? {
        kind: 'not-configured',
        ownerLabel,
        signInSavedHereOnly: isSignInSavedHereOnly(local, key)
      }
    : null
}

/** A numberless stand-in for a provider slot, carrying why it shows no usage. */
function ownerPlaceholderSnapshot(
  key: UsageProviderKey,
  error: string,
  usageMetadata: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    ...createPendingProviderSnapshot(USAGE_PROVIDER_IDS[key]),
    error,
    usageMetadata,
    status: 'error'
  }
}

// Why: hiding a provider set up here reads as "usage broke"; a numberless placeholder
// keeps it visible without passing this device's numbers off as the host's.
function addNotSetUpPlaceholders(
  local: RateLimitState,
  remote: RateLimitState,
  ownerLabel: string
): RateLimitState {
  return {
    ...remote,
    ...mapProviders((key) => {
      const ownerNotSetUp = describePlaceholder(local, remote, key, ownerLabel)
      if (!ownerNotSetUp) {
        return remote[key]
      }
      return ownerPlaceholderSnapshot(key, describeOwnerNotSetUp(ownerNotSetUp), {
        ownerNotSetUp
      })
    })
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
    return addNotSetUpPlaceholders(local, adoptRemoteRateLimits(owner.rateLimits), owner.ownerLabel)
  }
  // Why: nothing of the viewer's (numbers or setup flags) may stand in for the remote host.
  if (owner.kind === 'remote-pending') {
    return createEmptyRateLimitState(
      mapProviders((key) => createPendingProviderSnapshot(USAGE_PROVIDER_IDS[key]))
    )
  }
  const message = describeUnverifiableOwner(owner.ownerLabel, owner.reason)
  const base = owner.lastKnown ? adoptRemoteRateLimits(owner.lastKnown) : null
  const stamp = (key: UsageProviderKey): ProviderRateLimits =>
    ownerPlaceholderSnapshot(key, message, { unverifiableOwner: true })
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
