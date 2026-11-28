import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../agent-usage/rate-limits/rate-limit-types'
import type { CodexSystemDefaultIdentity } from '../managed-account-types'
import { isCodexAuthError } from './codex-auth-errors'

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

/** The parts of a usage read this verdict looks at, so a client's own decoded copy fits too. */
type CodexUsageRead = Pick<ProviderRateLimits, 'status' | 'error'> & {
  usageMetadata?: Pick<NonNullable<ProviderRateLimits['usageMetadata']>, 'failureKind'> | null
}

export function getCodexAccountAuthWarning(args: {
  limits: CodexUsageRead | null
  target: RateLimitRuntimeTarget
  runtime: AccountRuntime
  activeAccountId: string | null
  accountId: string | null
  authKind?: CodexSystemDefaultIdentity['authKind']
}): CodexAccountAuthWarning | null {
  if (args.accountId !== args.activeAccountId) {
    return null
  }
  // API-key homes report unsupported usage as ChatGPT auth errors; reauthentication cannot fix them.
  if (args.accountId === null && args.authKind === 'api-key') {
    return null
  }
  if (args.accountId === null && args.authKind === 'none') {
    return 'missing-sign-in'
  }
  if (!codexRateLimitTargetMatchesAccountRuntime(args.target, args.runtime)) {
    return null
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
  return 'stale-sign-in'
}
