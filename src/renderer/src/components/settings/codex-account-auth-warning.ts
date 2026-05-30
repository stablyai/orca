import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../shared/rate-limit-types'
import { isCodexAuthError } from '../../../../shared/codex-auth-errors'

type AccountRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

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
}): string | null {
  if (args.accountId !== args.activeAccountId) {
    return null
  }
  if (!codexRateLimitTargetMatchesAccountRuntime(args.target, args.runtime)) {
    return null
  }
  if (args.limits?.status !== 'error' || !isCodexAuthError(args.limits.error)) {
    return null
  }
  return args.limits.error?.trim() || 'Codex reported that this sign-in needs re-authentication.'
}
