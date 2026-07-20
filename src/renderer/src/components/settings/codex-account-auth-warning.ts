import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../shared/rate-limit-types'
import { isCodexAuthError } from '../../../../shared/codex-auth-errors'

// Why: an API-key-only Codex account is validly signed in. The app-server
// rejects account/rateLimits/read with "chatgpt authentication required to read
// rate limits" for such accounts, which isCodexAuthError classifies as an auth
// error so the rate-limit fetcher skips its PTY fallback. That classification is
// correct for the fetcher but not for this re-auth banner: the account does not
// need re-authentication, so showing a destructive warning would be wrong.
const CHATGPT_RATE_LIMIT_AUTH_REQUIRED_RE = /chatgpt authentication required/i

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
  if (args.limits.error && CHATGPT_RATE_LIMIT_AUTH_REQUIRED_RE.test(args.limits.error)) {
    return null
  }
  return args.limits.error?.trim() || 'Codex reported that this sign-in needs re-authentication.'
}
