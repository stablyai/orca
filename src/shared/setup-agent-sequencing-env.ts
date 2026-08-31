/** Env keys that carry the setup-to-agent gate between the host and the terminals it launches.
 *  Their own module so the POSIX and Windows gate builders can share them without importing
 *  each other. */
export const SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV = 'ORCA_SEQUENCED_STARTUP_COMMAND'
export const SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV = 'ORCA_SEQUENCED_STARTUP_SCRIPT'
export const SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV = 'ORCA_SEQUENCED_SETUP_SCRIPT'

/** Sentinel the setup half writes before running, shared by both platform gates. */
export function setupStartedPath(markerPath: string): string {
  return `${markerPath}.started`
}
