/** Share bootstrap latches across subscription closures to prevent duplicate creates on workspace switches (STA-6173). Key by environment AND worktree: repoId::path collides across hosts, and teardown must not release sibling claims (STA-4343). creating blocks all closures; success without a mirrored row enters awaiting-mirror. The next accepted frame releases only awaiting-mirror so missing publication cannot suppress retries until teardown. */
type InitialTerminalBootstrapPhase = 'creating' | 'awaiting-mirror'

const phaseByWorktreeByEnvironment = new Map<string, Map<string, InitialTerminalBootstrapPhase>>()

export function isWebRuntimeInitialTerminalBootstrapInFlight(
  environmentId: string,
  worktreeId: string
): boolean {
  return phaseByWorktreeByEnvironment.get(environmentId)?.has(worktreeId) ?? false
}

export function beginWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): boolean {
  const phases = phaseByWorktreeByEnvironment.get(environmentId)
  if (phases?.has(worktreeId)) {
    return false
  }
  if (phases) {
    phases.set(worktreeId, 'creating')
  } else {
    phaseByWorktreeByEnvironment.set(environmentId, new Map([[worktreeId, 'creating']]))
  }
  return true
}

/** The create resolved but no mirrored row exists yet; hold until the mirror answers. */
export function markWebRuntimeInitialTerminalBootstrapAwaitingMirror(
  environmentId: string,
  worktreeId: string
): void {
  const phases = phaseByWorktreeByEnvironment.get(environmentId)
  if (phases?.has(worktreeId)) {
    phases.set(worktreeId, 'awaiting-mirror')
  }
}

export function endWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): void {
  const phases = phaseByWorktreeByEnvironment.get(environmentId)
  if (!phases) {
    return
  }
  phases.delete(worktreeId)
  if (phases.size === 0) {
    phaseByWorktreeByEnvironment.delete(environmentId)
  }
}

/** Release only awaiting-mirror; releasing an in-flight create on a frame lets reinstalled closures create duplicates. */
export function releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame(
  environmentId: string,
  worktreeId: string
): void {
  if (phaseByWorktreeByEnvironment.get(environmentId)?.get(worktreeId) === 'awaiting-mirror') {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
  }
}

export function clearWebRuntimeInitialTerminalBootstrapsForEnvironment(
  environmentId: string
): void {
  phaseByWorktreeByEnvironment.delete(environmentId)
}

export function clearAllWebRuntimeInitialTerminalBootstraps(): void {
  phaseByWorktreeByEnvironment.clear()
}

export function resetWebRuntimeInitialTerminalBootstrapForTests(): void {
  clearAllWebRuntimeInitialTerminalBootstraps()
}
