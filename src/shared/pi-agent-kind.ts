import { isFreshOmpLaunchCommand } from './omp-fresh-launch'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { getCommandTokenPathBasename, getFirstCommandToken } from './command-token-scanner'
import { extractAgentLaunchCommand } from './agent-command-line-intent'

/** Pi-compatible agents share PI_CODING_AGENT_DIR and extension APIs but have separate user directories.
 * Never cross-fallback: switching agents must not shadow the other agent’s extensions. */
export type PiAgentKind = 'pi' | 'omp' | 'prime-agent'

export const PRIMARY_AGENT_DIR_ENV_BY_KIND: Readonly<Record<PiAgentKind, string>> = {
  pi: 'PI_CODING_AGENT_DIR',
  omp: 'PI_CODING_AGENT_DIR',
  'prime-agent': 'PRIME_AGENT_CODING_AGENT_DIR'
}

export const SOURCE_AGENT_DIR_ENV_BY_KIND: Readonly<Record<PiAgentKind, string>> = {
  pi: 'ORCA_PI_SOURCE_AGENT_DIR',
  omp: 'ORCA_OMP_SOURCE_AGENT_DIR',
  'prime-agent': 'ORCA_PRIME_AGENT_SOURCE_AGENT_DIR'
}

/** Pi-compatible agents emit agent_end milestones while still working; do not treat every event as turn completion. */
export function isPiCompatibleAgentType(
  agentType: string | null | undefined
): agentType is PiAgentKind {
  return agentType === 'pi' || agentType === 'omp' || agentType === 'prime-agent'
}

function getLaunchBinary(command: string): string {
  return getCommandTokenPathBasename(getFirstCommandToken(command))
    .toLowerCase()
    .replace(/\.(?:cmd|exe|sh)$/, '')
}

const PI_LAUNCH_BINARY = getLaunchBinary(TUI_AGENT_CONFIG.pi.launchCmd)
const OMP_LAUNCH_BINARY = getLaunchBinary(TUI_AGENT_CONFIG.omp.launchCmd)
const PRIME_AGENT_LAUNCH_BINARY = getLaunchBinary(TUI_AGENT_CONFIG['prime-agent'].launchCmd)

export function detectExplicitPiAgentKindFromCommand(
  command: string | undefined
): PiAgentKind | null {
  const launchCommand = extractAgentLaunchCommand(command ?? '')
  if (isFreshOmpLaunchCommand(launchCommand)) {
    return 'omp'
  }
  const binary = getLaunchBinary(launchCommand)
  if (binary === OMP_LAUNCH_BINARY) {
    return 'omp'
  }
  if (binary === PRIME_AGENT_LAUNCH_BINARY) {
    return 'prime-agent'
  }
  return binary === PI_LAUNCH_BINARY ? 'pi' : null
}

/** Detect the launched Pi-compatible kind; retain pi as the bare-shell integration default.
 * Missing directories must create only the resolved kind’s extension directory, never substitute another agent’s. */
export function detectPiAgentKindFromCommand(command: string | undefined): PiAgentKind {
  const explicitKind = detectExplicitPiAgentKindFromCommand(command)
  if (explicitKind) {
    return explicitKind
  }

  // Why: PI launches and the no-command (bare-shell) fallback both resolve to
  // 'pi'. A bare shell that later invokes `pi` keeps the historical default;
  // if it later invokes `omp`, the status extension re-routes at runtime based
  // on the executable name so attribution still lands on OMP.
  return 'pi'
}
