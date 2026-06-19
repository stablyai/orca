import type { AutoSwitchRateLimitAgent } from '../../../shared/agent-rate-limit-detection'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitWindow,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../../../shared/rate-limit-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../shared/types'

export type AutoSwitchAccountsSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

export type AutoSwitchAccountCandidate = {
  accountId: string
  label: string
  target: RateLimitRuntimeTarget
  usedPercent: number
}

type ProviderAccount =
  | ClaudeRateLimitAccountsState['accounts'][number]
  | CodexRateLimitAccountsState['accounts'][number]

type ProviderAccountsState = ClaudeRateLimitAccountsState | CodexRateLimitAccountsState

/** Produces a stable key for matching managed accounts to the active runtime scope. */
function getRuntimeKey(target: RateLimitRuntimeTarget): string {
  return target.runtime === 'wsl' ? (target.wslDistro ?? '__default__') : 'host'
}

/** Reads the provider-specific managed-account runtime shape as a generic target. */
function getAccountRuntime(
  agent: AutoSwitchRateLimitAgent,
  account: ProviderAccount
): RateLimitRuntimeTarget {
  if (agent === 'claude') {
    const claudeAccount = account as ClaudeRateLimitAccountsState['accounts'][number]
    return {
      runtime: claudeAccount.managedAuthRuntime === 'wsl' ? 'wsl' : 'host',
      wslDistro:
        claudeAccount.managedAuthRuntime === 'wsl' ? (claudeAccount.wslDistro ?? null) : null
    }
  }

  const codexAccount = account as CodexRateLimitAccountsState['accounts'][number]
  return {
    runtime: codexAccount.managedHomeRuntime === 'wsl' ? 'wsl' : 'host',
    wslDistro: codexAccount.managedHomeRuntime === 'wsl' ? (codexAccount.wslDistro ?? null) : null
  }
}

/** Keeps auto-switch within the same host or exact WSL distro as the limited session. */
function accountMatchesTarget(
  agent: AutoSwitchRateLimitAgent,
  account: ProviderAccount,
  target: RateLimitRuntimeTarget
): boolean {
  const accountRuntime = getAccountRuntime(agent, account)
  if (accountRuntime.runtime !== target.runtime) {
    return false
  }
  if (target.runtime === 'host') {
    return true
  }
  return getRuntimeKey(accountRuntime) === getRuntimeKey(target)
}

/** Resolves the active account for the target runtime, preserving legacy host fallback. */
function getActiveAccountId(
  state: ProviderAccountsState,
  target: RateLimitRuntimeTarget
): string | null {
  const selection = state.activeAccountIdsByRuntime
  if (target.runtime === 'host') {
    return selection?.host ?? state.activeAccountId ?? null
  }
  const runtimeKey = getRuntimeKey(target)
  const exact = selection?.wsl?.[runtimeKey]
  if (target.wslDistro || exact) {
    return exact ?? null
  }
  const selectedIds = Array.from(new Set(Object.values(selection?.wsl ?? {}).filter(Boolean)))
  return selectedIds.length === 1 ? selectedIds[0] : null
}

/** Scores an inactive account by its tightest reported quota window. */
function getUsageScore(limits: ProviderRateLimits | null | undefined): number | null {
  if (!limits || limits.status !== 'ok') {
    return null
  }
  const windows = [
    limits.session,
    limits.weekly,
    limits.monthly ?? null,
    ...(limits.buckets ?? [])
  ].filter((window): window is RateLimitWindow => window !== null)
  if (windows.length === 0) {
    return null
  }
  const usedPercent = Math.max(...windows.map((window) => window.usedPercent))
  return usedPercent < 100 ? usedPercent : null
}

/** Indexes only usable inactive accounts; exhausted or errored accounts are omitted. */
function getInactiveUsageByAccountId(usages: readonly InactiveAccountUsage[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const usage of usages) {
    const score = getUsageScore(usage.rateLimits)
    if (score !== null) {
      result.set(usage.accountId, score)
    }
  }
  return result
}

/** Chooses the lowest-usage inactive managed account for the current provider/runtime. */
export function selectAutoSwitchAccount(args: {
  agent: AutoSwitchRateLimitAgent
  accounts: AutoSwitchAccountsSnapshot
  target: RateLimitRuntimeTarget
}): AutoSwitchAccountCandidate | null {
  const providerAccounts = args.agent === 'claude' ? args.accounts.claude : args.accounts.codex
  const inactiveUsage =
    args.agent === 'claude'
      ? args.accounts.rateLimits.inactiveClaudeAccounts
      : args.accounts.rateLimits.inactiveCodexAccounts
  const activeAccountId = getActiveAccountId(providerAccounts, args.target)
  const usageByAccountId = getInactiveUsageByAccountId(inactiveUsage)

  const candidates = providerAccounts.accounts
    .filter((account) => account.id !== activeAccountId)
    .filter((account) => accountMatchesTarget(args.agent, account, args.target))
    .map((account) => {
      const usedPercent = usageByAccountId.get(account.id)
      if (usedPercent === undefined) {
        return null
      }
      return {
        accountId: account.id,
        label: account.email,
        target: getAccountRuntime(args.agent, account),
        usedPercent
      } satisfies AutoSwitchAccountCandidate
    })
    .filter((candidate): candidate is AutoSwitchAccountCandidate => candidate !== null)
    .sort((left, right) => left.usedPercent - right.usedPercent)

  return candidates[0] ?? null
}
