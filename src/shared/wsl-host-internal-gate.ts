/** Keep WSL hosts internal until project moves are lossless and WSL parity is met. Main/preload agree through the same launch environment. */
export const WSL_HOSTS_INTERNAL_GATE_ENV = 'ORCA_INTERNAL_WSL_HOSTS'

export function isWslHostsInternalGateOpen(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[WSL_HOSTS_INTERNAL_GATE_ENV] === '1'
}

/**
 * `open`: everything. `serve-only`: the gate is closed, but a saved host or a move journal exists,
 * so its projects stay reachable while nothing new is added or moved. `closed`: no WSL host surface.
 */
export type WslHostsGateState = 'open' | 'serve-only' | 'closed'

export function resolveWslHostsGateState(facts: {
  gateOpen: boolean
  hasSavedWslHost: boolean
  hasWslMoveCutover: boolean
}): WslHostsGateState {
  if (facts.gateOpen) {
    return 'open'
  }
  return facts.hasSavedWslHost || facts.hasWslMoveCutover ? 'serve-only' : 'closed'
}

// Main records serve-only here so shared readers in its process agree; other processes never set it.
let serveOnlyNoted = false

export function noteWslHostsServeOnly(serveOnly: boolean): void {
  serveOnlyNoted = serveOnly
}

/** Open, or main found saved WSL work behind the closed gate. */
export function isWslHostsServing(env: Readonly<Record<string, string | undefined>>): boolean {
  return isWslHostsInternalGateOpen(env) || serveOnlyNoted
}

// Preload has no disk access, so main stamps the promoted state into the window's argv at birth.
const SERVE_ONLY_ARGUMENT = '--orca-wsl-hosts-serve-only'

export function formatWslHostsServeOnlyArgument(): string {
  return SERVE_ONLY_ARGUMENT
}

export function hasWslHostsServeOnlyArgument(argv: readonly string[]): boolean {
  return argv.includes(SERVE_ONLY_ARGUMENT)
}
