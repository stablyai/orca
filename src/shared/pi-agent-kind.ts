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
export type PiAgentKind = 'pi' | 'omp'

const OMP_LAUNCH_CMD = TUI_AGENT_CONFIG.omp.launchCmd

// Why: regex carved to avoid matching `pi` inside `pip`, `mpi`, `api`,
// `python`, or `omp` inside `comp`, `omp.sh` (acceptable - that's literally
// the binary), `omp-foo`, etc. The leading boundary excludes alnum/underscore
// AND `-`/`.`/`/`/`\\` so that `~/bin/pi` or `./omp` still match but
// `mpi`/`pomp` do not. Trailing boundary allows whitespace, end-of-string,
// shell separators, or argv-style flags (`pi -v`, `omp --help`).
const BOUNDARY_BEFORE = `(?:^|[\\s;&|('"\`])`
const BOUNDARY_AFTER = `(?:$|[\\s;&|)'"\`])`
const PATH_PREFIX = `(?:[^\\s;&|('"\`]*[\\\\/])?`

function makeLaunchCmdRegex(launchCmd: string): RegExp {
  // Why: launchCmd may be a multi-token string ("hermes --tui"); only the
  // first token is the binary name. Use that for matching.
  const binary = getCommandTokenPathBasename(getFirstCommandToken(launchCmd))
  const escaped = binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `${BOUNDARY_BEFORE}${PATH_PREFIX}${escaped}(?:\\.cmd|\\.exe|\\.sh)?${BOUNDARY_AFTER}`,
    'i'
  )
}

const OMP_REGEX = makeLaunchCmdRegex(OMP_LAUNCH_CMD)

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
  if (typeof command === 'string' && OMP_REGEX.test(command)) {
    return 'omp'
  }
  // Why: PI launches and the no-command (bare-shell) fallback both resolve to
  // 'pi'. A bare shell that later invokes `pi` keeps the historical default;
  // if it later invokes `omp`, the status extension re-routes at runtime based
  // on the executable name so attribution still lands on OMP.
  return 'pi'
}
