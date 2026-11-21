import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { hasUsageData } from '../../../../../../shared/agent-usage/display/usage-provider-windows'
import { getUsageRosterRowState } from '../../../status-bar/usage/usage-roster-row-state'

type AccountRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

export type ClaudeSystemDefaultSignInWarning = 'missing-sign-in'

function rateLimitTargetMatchesAccountRuntime(
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

/**
 * System default Claude follows the status-bar sign-in classification.
 * Callers pass null limits for a remote host: a desktop poll describes this machine, not that login.
 */
export function getClaudeSystemDefaultSignInWarning(args: {
  limits: ProviderRateLimits | null
  target: RateLimitRuntimeTarget
  runtime: AccountRuntime
  activeAccountId: string | null
}): ClaudeSystemDefaultSignInWarning | null {
  if (args.activeAccountId !== null || args.limits === null) {
    return null
  }
  if (!rateLimitTargetMatchesAccountRuntime(args.target, args.runtime)) {
    return null
  }
  const row = getUsageRosterRowState(args.limits, hasUsageData(args.limits))
  return row.kind === 'sign-in' ? 'missing-sign-in' : null
}
