/** Inactive-usage keys for each provider's host System default login, which has no saved account id. */
export const HOST_SYSTEM_DEFAULT_USAGE_IDS = {
  claude: 'claude-system-default',
  codex: 'codex-system-default'
} as const

/** A WSL System default is the distro's own login, so only the host's has a usage key. */
export function hostSystemDefaultUsageId(
  provider: keyof typeof HOST_SYSTEM_DEFAULT_USAGE_IDS,
  target?: { runtime?: 'host' | 'wsl' }
): string | null {
  return target?.runtime === 'wsl' ? null : HOST_SYSTEM_DEFAULT_USAGE_IDS[provider]
}
