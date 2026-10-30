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
// Main records a remote policy block the same way: it closes the internal gate for the run.
let policyBlockNoted = false

export function noteWslHostsServeOnly(serveOnly: boolean): void {
  serveOnlyNoted = serveOnly
}

export function noteWslHostsPolicyBlocked(blocked: boolean): void {
  policyBlockNoted = blocked
}

/**
 * Main publishes its resolved state here so the processes it spawns (CLI, servers, terminals) read
 * the gate as main does: they inherit the internal gate env var but neither note above.
 */
export const WSL_HOSTS_GATE_STATE_ENV = 'ORCA_WSL_HOSTS_GATE_STATE'
// True once this process resolved the gate itself; an inherited value is then a parent's, so stale.
let resolvedHere = false

export function publishWslHostsGateState(
  env: Record<string, string | undefined>,
  state: WslHostsGateState | null
): void {
  resolvedHere = state !== null
  if (state === null) {
    delete env[WSL_HOSTS_GATE_STATE_ENV]
  } else {
    env[WSL_HOSTS_GATE_STATE_ENV] = state
  }
}

/** Main's entry, before anything reads the gate: it recomputes its own, so an inherited value is stale. */
export function ignoreInheritedWslHostsGateState(): void {
  resolvedHere = true
}

function inheritedGateState(
  env: Readonly<Record<string, string | undefined>>
): WslHostsGateState | null {
  const value = env[WSL_HOSTS_GATE_STATE_ENV]
  return value === 'open' || value === 'serve-only' || value === 'closed' ? value : null
}

/** Open, or main found saved WSL work behind the closed gate. */
export function isWslHostsServing(env: Readonly<Record<string, string | undefined>>): boolean {
  const inherited = resolvedHere ? null : inheritedGateState(env)
  if (inherited) {
    return inherited !== 'closed'
  }
  return (isWslHostsInternalGateOpen(env) && !policyBlockNoted) || serveOnlyNoted
}

// Preload has no disk access, so main stamps the promoted state into the window's argv at birth.
const SERVE_ONLY_ARGUMENT = '--orca-wsl-hosts-serve-only'

export function formatWslHostsServeOnlyArgument(): string {
  return SERVE_ONLY_ARGUMENT
}

export function hasWslHostsServeOnlyArgument(argv: readonly string[]): boolean {
  return argv.includes(SERVE_ONLY_ARGUMENT)
}

// The remote policy closed an internal gate the launch environment opened.
const POLICY_BLOCKED_ARGUMENT = '--orca-wsl-hosts-policy-blocked'

export function formatWslHostsPolicyBlockedArgument(): string {
  return POLICY_BLOCKED_ARGUMENT
}

/** Preload's view of the gate: the launch environment, less a remote block, plus serve-only. */
export function isWslHostsServingForWindow(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[]
): boolean {
  return (
    (isWslHostsInternalGateOpen(env) && !argv.includes(POLICY_BLOCKED_ARGUMENT)) ||
    hasWslHostsServeOnlyArgument(argv)
  )
}
