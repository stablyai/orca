import type { RateLimitRuntimeTarget } from '../../../../shared/rate-limit-types'

export type AccountRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

/**
 * True when a rate-limit poll describes the runtime an account row belongs to.
 *
 * The poll can be retargeted independently of the account view, so a row must
 * check this before it renders a percentage as its own.
 */
export function rateLimitTargetMatchesAccountRuntime(
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
