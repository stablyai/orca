/**
 * Absolute mesh paths for omp --config / --session-dir.
 *
 * Orca tokenizes agentArgs and single-quotes every token for the PTY startup
 * command (`quoteStartupArg`). That means a literal `$HOME/...` never expands
 * in the shell — omp then resolves it relative to the worktree cwd as
 * `/path/to/repo/$HOME/meshina/...` and dies with "Config overlay not found".
 *
 * Dogfood 2026-07-22: pet + board spawns failed that way. Expand owner home
 * here so argv paths are absolute on the local host. Persona text may still
 * mention `$HOME` for operator docs; only CLI path flags need expansion.
 */
export function resolveMeshOwnerHome(): string {
  const fromEnv =
    (typeof process !== 'undefined' && (process.env.HOME || process.env.USERPROFILE)) || ''
  const trimmed = fromEnv.trim().replace(/\/+$/, '')
  if (trimmed.length > 0) {
    return trimmed
  }
  // Mesh nodes are operator-owned; prefer a real path over a non-expanding $HOME.
  return '/home/nixos'
}

export function meshOmpSessionRoot(): string {
  return `${resolveMeshOwnerHome()}/.local/state/meshina/omp-sessions`
}

export function meshOmpCodingConfigPath(): string {
  return `${resolveMeshOwnerHome()}/meshina/configs/omp/mesh-coding.yml`
}

/** Path named in persona / docs (not used as a quoted CLI path). */
export function meshOmpMcpConfigDocPath(): string {
  return '$HOME/meshina/configs/omp/mcp.json'
}
