import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../shared/rate-limit-types'

type AccountRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

export function claudeRateLimitTargetMatchesAccountRuntime(
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

// Why: the desktop usage snapshot describes the viewed login only when its
// target matches; otherwise the warning would blame the wrong environment.
export function getClaudeSystemDefaultSignInWarning(args: {
  limits: ProviderRateLimits | null
  target: RateLimitRuntimeTarget
  runtime: AccountRuntime
  systemActive: boolean
}): boolean {
  if (!args.systemActive) {
    return false
  }
  if (!claudeRateLimitTargetMatchesAccountRuntime(args.target, args.runtime)) {
    return false
  }
  return args.limits?.status === 'error' && args.limits.usageMetadata?.failureKind === 'signed-out'
}
