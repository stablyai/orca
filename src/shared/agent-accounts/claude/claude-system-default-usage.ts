import { hostSystemDefaultUsageId } from '../host-system-default-usage'

/** The key an unselected row's usage is published under. */
export function claudeInactiveUsageId(target: {
  id: string | null
  active: boolean
  runtimeTarget: { runtime: 'host' | 'wsl' }
}): string | null {
  return target.active
    ? null
    : (target.id ?? hostSystemDefaultUsageId('claude', target.runtimeTarget))
}
