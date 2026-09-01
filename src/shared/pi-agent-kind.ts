import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { getCommandTokenPathBasename, getFirstCommandToken } from './command-token-scanner'

/**
 * Pi-compatible agent kinds. Both Pi and OMP (omp.sh) consume the same
 * `PI_CODING_AGENT_DIR` env contract and the same extension API, but each
 * defaults its on-disk config dir to a different `~/.<kind>/agent` path.
 * Orca's managed extension installer needs to know which agent is being
 * launched so it targets the user's actual source dir for THAT agent, with no
 * cross-agent fallback
 * (otherwise switching agents in the same workspace silently shadows the
 * other agent's user extensions).
 */
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

/**
 * True when `agentType` names a Pi-compatible (goal/mission) kind. These agents
 * emit milestone `agent_end` events between steps while still working, so they
 * are treated differently from agents that only signal completion at turn end.
 */
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

const PI_LAUNCH_BINARY = getLaunchBinary(TUI_AGENT_CONFIG.pi.launchArgv?.[0] ?? TUI_AGENT_CONFIG.pi.launchCmd)
const OMP_LAUNCH_BINARY = getLaunchBinary(TUI_AGENT_CONFIG.omp.launchArgv?.[0] ?? TUI_AGENT_CONFIG.omp.launchCmd)
const PRIME_AGENT_LAUNCH_BINARY = getLaunchBinary(
  TUI_AGENT_CONFIG['prime-agent'].launchArgv?.[0] ?? TUI_AGENT_CONFIG['prime-agent'].launchCmd
)

export function detectExplicitPiAgentKindFromCommand(
  command: string | undefined
): PiAgentKind | null {
  const binary = getLaunchBinary(command ?? '')
  if (binary === OMP_LAUNCH_BINARY) {
    return 'omp'
  }
  if (binary === PRIME_AGENT_LAUNCH_BINARY) {
    return 'prime-agent'
  }
  return binary === PI_LAUNCH_BINARY ? 'pi' : null
}

/**
 * Identify the Pi-compatible agent kind a launch command targets.
 *
 * Returns 'omp' when the command launches OMP (`omp` / `omp.sh`), otherwise
 * defaults to 'pi'. Defaulting to 'pi' preserves prior behavior for the
 * non-launch case (e.g. bare shells that may later invoke `pi`) where Orca
 * prepared Pi integration by default.
 *
 * NEVER cross-fall-back: a missing source dir for the resolved kind means
 * "create that kind's extension dir only" - the other agent's dir MUST NOT
 * be substituted.
 */
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
