/** Keep WSL hosts internal until project moves are lossless and WSL parity is met. Main/preload agree through the same launch environment. */
export const WSL_HOSTS_INTERNAL_GATE_ENV = 'ORCA_INTERNAL_WSL_HOSTS'

export function isWslHostsInternalGateOpen(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[WSL_HOSTS_INTERNAL_GATE_ENV] === '1'
}
