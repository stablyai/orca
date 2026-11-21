/** Inactive-usage key for the host System default login, which has no saved account id. */
export const CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID = 'claude-system-default'

/** The key an unselected row's usage is published under; a WSL System default is another login. */
export function claudeInactiveUsageId(target: {
  id: string | null
  active: boolean
  runtimeTarget: { runtime: 'host' | 'wsl' }
}): string | null {
  if (target.active) {
    return null
  }
  return (
    target.id ??
    (target.runtimeTarget.runtime === 'host' ? CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID : null)
  )
}
