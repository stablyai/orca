/** Inactive-usage key for the host System default login, which has no saved account id. */
export const CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID = 'claude-system-default'

/** A WSL System default is another login, so only the host's has a usage key. */
export function claudeSystemDefaultUsageId(target?: { runtime?: 'host' | 'wsl' }): string | null {
  return target?.runtime === 'wsl' ? null : CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID
}

/** The key an unselected row's usage is published under. */
export function claudeInactiveUsageId(target: {
  id: string | null
  active: boolean
  runtimeTarget: { runtime: 'host' | 'wsl' }
}): string | null {
  return target.active ? null : (target.id ?? claudeSystemDefaultUsageId(target.runtimeTarget))
}
