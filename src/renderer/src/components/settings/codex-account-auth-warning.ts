import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../shared/rate-limit-types'
import type { CodexSystemDefaultIdentity } from '../../../../shared/types'
import { isCodexAuthError } from '../../../../shared/codex-auth-errors'

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
  if (args.accountId !== args.activeAccountId) {
    return null
  }
  // Why: app-server reports API-key homes as a ChatGPT-auth error because
  // usage is unsupported; that is not a stale sign-in the user can re-auth.
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
  return 'stale-sign-in'
}
