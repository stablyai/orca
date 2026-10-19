/**
 * Internal-only gate for WSL distros as hosts, closed in every build: users must not reach the
 * feature until moving a project between hosts is lossless and it matches today's WSL support.
 * Main and preload read the same launch environment, so they always agree.
 */
export const WSL_HOSTS_INTERNAL_GATE_ENV = 'ORCA_INTERNAL_WSL_HOSTS'

export function isWslHostsInternalGateOpen(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[WSL_HOSTS_INTERNAL_GATE_ENV] === '1'
}
