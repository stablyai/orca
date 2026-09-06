import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  CodexSystemDefaultIdentity
} from '../../../../shared/managed-account-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitState,
  UsageRateLimitFailureKind
} from '../../../../shared/rate-limit-types'
import { isCodexAuthError } from '../../../../shared/codex-auth-errors'

export type AgentReadinessProvider = 'claude' | 'codex'
export type AgentReadinessState =
  | 'ready'
  | 'checking'
  | 'action-required'
  | 'degraded'
  | 'unavailable'
  | 'unknown'

export const AGENT_READINESS_STATE_PRIORITY: Readonly<Record<AgentReadinessState, number>> = {
  ready: 0,
  unknown: 1,
  checking: 2,
  degraded: 3,
  unavailable: 4,
  'action-required': 5
}

export type AgentReadinessReason =
  | 'ready'
  | 'refreshing'
  | 'session-active'
  | 'cli-checking'
  | 'cli-unavailable'
  | 'sign-in-required'
  | 'sign-in-refreshing'
  | 'credential-unavailable'
  | 'network'
  | 'provider-error'
  | 'limited'
  | 'usage-unavailable'
  | 'api-key-configured'
  | 'not-checked'

export type AgentAccountReadiness = {
  id: string | null
  label: string
  active: boolean
  state: AgentReadinessState
  reason: AgentReadinessReason
  checkedAt: number | null
}

export type AgentProviderReadiness = {
  provider: AgentReadinessProvider
  installed: boolean | null
  linkedAccountCount: number
  state: AgentReadinessState
  reason: AgentReadinessReason
  activeAccount: AgentAccountReadiness | null
  accounts: AgentAccountReadiness[]
}

export type AgentReadinessInput = {
  claudeAccounts: ClaudeRateLimitAccountsState
  codexAccounts: CodexRateLimitAccountsState
  rateLimits: RateLimitState | null
  detectedAgentIds: readonly TuiAgent[] | null
  detectionPending: boolean
  systemDefaultLabel: string
}

type ClassifiedReadiness = Pick<AgentAccountReadiness, 'state' | 'reason' | 'checkedAt'>

type AccountSource = { id: string | null; label: string }

const SIGN_IN_REFRESH_FAILURES: ReadonlySet<UsageRateLimitFailureKind> = new Set([
  'stale-token',
  'refreshable-credentials-without-token',
  'delegated-refresh-required'
])

const ACTION_REQUIRED_FAILURES: ReadonlySet<UsageRateLimitFailureKind> = new Set([
  'missing-credentials',
  'missing-scope'
])

function hasUsageData(limits: ProviderRateLimits): boolean {
  return Boolean(
    limits.session ||
    limits.weekly ||
    limits.fableWeekly ||
    limits.monthly ||
    limits.buckets?.length
  )
}

function classifyFailure(
  provider: AgentReadinessProvider,
  limits: ProviderRateLimits
): Omit<ClassifiedReadiness, 'checkedAt'> {
  const failure = limits.usageMetadata?.failureKind
  if (failure === 'deferred-by-live-session') {
    return { state: 'ready', reason: 'session-active' }
  }
  if (provider === 'claude' && failure && SIGN_IN_REFRESH_FAILURES.has(failure)) {
    return { state: 'checking', reason: 'sign-in-refreshing' }
  }
  if (failure && ACTION_REQUIRED_FAILURES.has(failure)) {
    return { state: 'action-required', reason: 'sign-in-required' }
  }
  if (failure === 'keychain-unavailable') {
    return { state: 'action-required', reason: 'credential-unavailable' }
  }
  if (failure === 'cli-unavailable') {
    return { state: 'unavailable', reason: 'cli-unavailable' }
  }
  if (failure === 'network') {
    return { state: 'degraded', reason: 'network' }
  }
  if (failure === 'rate-limited') {
    return { state: 'degraded', reason: 'limited' }
  }
  if (failure === 'usage-unavailable') {
    return { state: 'degraded', reason: 'usage-unavailable' }
  }
  if (provider === 'codex' && isCodexAuthError(limits.error)) {
    return { state: 'action-required', reason: 'sign-in-required' }
  }
  return { state: 'degraded', reason: 'provider-error' }
}

function classifyAccount(args: {
  provider: AgentReadinessProvider
  installed: boolean | null
  cliPending: boolean
  limits: ProviderRateLimits | null
  isFetching?: boolean
  codexSystemAuthKind?: CodexSystemDefaultIdentity['authKind']
}): ClassifiedReadiness {
  const checkedAt = args.limits?.updatedAt ? args.limits.updatedAt : null
  if (args.installed === false) {
    return { state: 'unavailable', reason: 'cli-unavailable', checkedAt }
  }
  if (args.installed === null) {
    return args.cliPending
      ? { state: 'checking', reason: 'cli-checking', checkedAt }
      : { state: 'unknown', reason: 'not-checked', checkedAt }
  }
  if (args.codexSystemAuthKind === 'none') {
    return { state: 'action-required', reason: 'sign-in-required', checkedAt }
  }
  if (args.codexSystemAuthKind === 'api-key') {
    return { state: 'ready', reason: 'api-key-configured', checkedAt }
  }
  if (!args.limits) {
    return args.isFetching
      ? { state: 'checking', reason: 'refreshing', checkedAt: null }
      : { state: 'unknown', reason: 'not-checked', checkedAt: null }
  }
  if (args.limits.status === 'idle') {
    return { state: 'checking', reason: 'refreshing', checkedAt }
  }
  if (args.limits.status === 'fetching') {
    return hasUsageData(args.limits)
      ? { state: 'ready', reason: 'refreshing', checkedAt }
      : { state: 'checking', reason: 'refreshing', checkedAt }
  }
  if (args.limits.status === 'ok') {
    return { state: 'ready', reason: 'ready', checkedAt }
  }
  return { ...classifyFailure(args.provider, args.limits), checkedAt }
}

function targetKey(target: RateLimitRuntimeTarget): string {
  return target.wslDistro?.trim() || '__default__'
}

function activeIdForTarget(
  state: ClaudeRateLimitAccountsState | CodexRateLimitAccountsState,
  target: RateLimitRuntimeTarget
): string | null {
  if (target.runtime === 'host') {
    return state.activeAccountIdsByRuntime?.host ?? state.activeAccountId ?? null
  }
  const selections = state.activeAccountIdsByRuntime?.wsl ?? {}
  const direct = selections[targetKey(target)]
  if (target.wslDistro || direct) {
    return direct ?? null
  }
  const selected = Array.from(new Set(Object.values(selections).filter(Boolean)))
  return selected.length === 1 ? selected[0] : null
}

function accountMatchesTarget(
  runtime: 'host' | 'wsl' | undefined,
  wslDistro: string | null | undefined,
  target: RateLimitRuntimeTarget
): boolean {
  if (target.runtime === 'host') {
    return runtime !== 'wsl'
  }
  const accountKey = wslDistro?.trim() || '__default__'
  return runtime === 'wsl' && (!target.wslDistro || targetKey(target) === accountKey)
}

function inactiveLimitsFor(
  inactiveAccounts: readonly InactiveAccountUsage[],
  accountId: string
): { limits: ProviderRateLimits | null; isFetching: boolean } {
  const entry = inactiveAccounts.find((candidate) => candidate.accountId === accountId)
  return { limits: entry?.rateLimits ?? null, isFetching: entry?.isFetching ?? false }
}

function buildProvider(args: {
  provider: AgentReadinessProvider
  installed: boolean | null
  cliPending: boolean
  accounts: AccountSource[]
  activeId: string | null
  activeLimits: ProviderRateLimits | null
  inactiveAccounts: readonly InactiveAccountUsage[]
  systemLabel: string
  codexSystemAuthKind?: 'oauth' | 'api-key' | 'none'
}): AgentProviderReadiness {
  const sources: AccountSource[] = [{ id: null, label: args.systemLabel }, ...args.accounts]
  const accounts = sources.map((account): AgentAccountReadiness => {
    const active = account.id === args.activeId
    const inactive = account.id
      ? inactiveLimitsFor(args.inactiveAccounts, account.id)
      : { limits: null, isFetching: false }
    const classified = classifyAccount({
      provider: args.provider,
      installed: args.installed,
      cliPending: args.cliPending,
      limits: active ? args.activeLimits : inactive.limits,
      isFetching: active ? args.activeLimits?.status === 'fetching' : inactive.isFetching,
      codexSystemAuthKind:
        args.provider === 'codex' && account.id === null && active
          ? args.codexSystemAuthKind
          : undefined
    })
    return { ...account, active, ...classified }
  })
  const activeAccount = accounts.find((account) => account.active) ?? null
  return {
    provider: args.provider,
    installed: args.installed,
    linkedAccountCount: args.accounts.length,
    state: activeAccount?.state ?? 'unknown',
    reason: activeAccount?.reason ?? 'not-checked',
    activeAccount,
    accounts
  }
}

export function buildAgentReadiness(input: AgentReadinessInput): AgentProviderReadiness[] {
  const detected = input.detectionPending ? null : input.detectedAgentIds
  const installed = (provider: AgentReadinessProvider): boolean | null =>
    detected === null ? null : detected.includes(provider)
  const claudeTarget = input.rateLimits?.claudeTarget ?? { runtime: 'host', wslDistro: null }
  const codexTarget = input.rateLimits?.codexTarget ?? { runtime: 'host', wslDistro: null }
  const claudeSources = input.claudeAccounts.accounts
    .filter((account) =>
      accountMatchesTarget(account.managedAuthRuntime, account.wslDistro, claudeTarget)
    )
    .map((account) => ({ id: account.id, label: account.email }))
  const codexSources = input.codexAccounts.accounts
    .filter((account) =>
      accountMatchesTarget(account.managedHomeRuntime, account.wslDistro, codexTarget)
    )
    .map((account) => ({ id: account.id, label: account.email }))
  const systemCodexLabel = input.codexAccounts.systemDefault?.email
    ? `${input.systemDefaultLabel} · ${input.codexAccounts.systemDefault.email}`
    : input.systemDefaultLabel

  return [
    buildProvider({
      provider: 'claude',
      installed: installed('claude'),
      cliPending: input.detectionPending,
      accounts: claudeSources,
      activeId: activeIdForTarget(input.claudeAccounts, claudeTarget),
      activeLimits: input.rateLimits?.claude ?? null,
      inactiveAccounts: input.rateLimits?.inactiveClaudeAccounts ?? [],
      systemLabel: input.systemDefaultLabel
    }),
    buildProvider({
      provider: 'codex',
      installed: installed('codex'),
      cliPending: input.detectionPending,
      accounts: codexSources,
      activeId: activeIdForTarget(input.codexAccounts, codexTarget),
      activeLimits: input.rateLimits?.codex ?? null,
      inactiveAccounts: input.rateLimits?.inactiveCodexAccounts ?? [],
      systemLabel: systemCodexLabel,
      codexSystemAuthKind: input.codexAccounts.systemDefault?.authKind
    })
  ]
}

export function shouldShowAgentReadiness(provider: AgentProviderReadiness): boolean {
  return provider.installed !== false || provider.linkedAccountCount > 0
}

export function getOverallAgentReadiness(
  providers: readonly AgentProviderReadiness[]
): AgentReadinessState {
  return providers.reduce<AgentReadinessState>(
    (current, provider) =>
      AGENT_READINESS_STATE_PRIORITY[provider.state] > AGENT_READINESS_STATE_PRIORITY[current]
        ? provider.state
        : current,
    'ready'
  )
}
