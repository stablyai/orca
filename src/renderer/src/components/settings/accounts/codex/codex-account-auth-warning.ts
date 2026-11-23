import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { CodexSystemDefaultIdentity } from '../../../../../../shared/agent-accounts/managed-account-types'
import { isCodexAuthError } from '../../../../../../shared/agent-accounts/codex/codex-auth-errors'
import { isSameUsageSlot } from '../../../../../../shared/agent-usage/rate-limits/account-usage-observations'

type AccountRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

type CodexAccountAuthWarning = 'missing-sign-in' | 'stale-sign-in'

export function codexRateLimitTargetMatchesAccountRuntime(
  target: RateLimitRuntimeTarget,
  runtime: AccountRuntime
): boolean {
  if (target.runtime !== runtime.runtime) {
    return false
  }
  if (runtime.runtime === 'host') {
    return true
  }
  return !runtime.wslDistro || target.wslDistro === runtime.wslDistro
}

export function getCodexAccountAuthWarning(args: {
  limits: ProviderRateLimits | null
  target: RateLimitRuntimeTarget
  runtime: AccountRuntime
  activeAccountId: string | null
  accountId: string | null
  authKind?: CodexSystemDefaultIdentity['authKind']
}): CodexAccountAuthWarning | null {
  // A saved account's warning follows its own failed attempt, even after another window switches away.
  if (args.accountId === null && args.activeAccountId !== null) {
    return null
  }
  // API-key homes report unsupported usage as ChatGPT auth errors; reauthentication cannot fix them.
  if (args.accountId === null && args.authKind === 'api-key') {
    return null
  }
  if (args.accountId === null && args.authKind === 'none') {
    return 'missing-sign-in'
  }
  if (args.limits?.status !== 'error' || !isCodexAuthError(args.limits.error)) {
    return null
  }
  // WSL system defaults have no resolved authKind; the fetcher marks a home it proved has no ChatGPT login instead.
  if (
    args.accountId === null &&
    args.authKind === undefined &&
    args.runtime.runtime === 'wsl' &&
    args.limits.usageMetadata?.failureKind === 'usage-unavailable'
  ) {
    return null
  }
  // Another window can switch accounts mid-fetch; only the slot the fetch tried failed to sign in.
  const attempted = args.limits.usageMetadata?.attemptedAccount
  // An unnamed WSL target reads the default distro, which its own attempt names.
  const target: RateLimitRuntimeTarget =
    args.target.runtime === 'wsl' && args.target.wslDistro === null
      ? { runtime: 'wsl', wslDistro: attempted?.wslDistro ?? null }
      : args.target
  if (!codexRateLimitTargetMatchesAccountRuntime(target, args.runtime)) {
    return null
  }
  return isSameUsageSlot(attempted, {
    accountId: args.accountId,
    runtime: target.runtime,
    wslDistro: target.wslDistro
  })
    ? 'stale-sign-in'
    : null
}
