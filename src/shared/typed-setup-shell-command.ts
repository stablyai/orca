/** Why 127: "command not found" is the closest POSIX status for a script that never arrived. */
export const SETUP_SCRIPT_MISSING_STATUS = 127

export const SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV = 'ORCA_SEQUENCED_STARTUP_COMMAND'
export const SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV = 'ORCA_SEQUENCED_STARTUP_SCRIPT'
export const SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV = 'ORCA_SEQUENCED_SETUP_SCRIPT'
export const POSIX_SETUP_OBSERVED_SCRIPT_ENV = 'ORCA_SETUP_OBSERVED_SCRIPT'
/** Why one list next to the builder: these are the variables a typed setup/startup command reads,
 *  so every spawn path that crosses a shell boundary (WSLENV on the daemon and on the relay) must
 *  forward all of them or the typed command evaluates to nothing (#18059). */
export const SETUP_SCRIPT_CARRIER_ENV_NAMES = [
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV,
  POSIX_SETUP_OBSERVED_SCRIPT_ENV
] as const

/**
 * Builds the one-line text Orca types into a user's interactive shell to run a setup or startup
 * script that travels in `scriptEnvName` instead of in the keystrokes.
 *
 * Why nothing but words, `$` and balanced quotes: single-line startup commands are delivered as
 * keystrokes through the user's line editor, where pair-inserting widgets (zsh-autopair, fish,
 * many .inputrc setups) insert a matching `)`/`]`/`}` and corrupt the command before the shell
 * parses it (#18059).
 *
 * Why the guard: an env carrier that drops the variable would otherwise make the typed command a
 * silent no-op — exit 0, no output — which reads as "setup is still running" forever. `report`
 * must be a line-editor-safe command (no brackets, no single quotes) that announces the miss.
 */
export function buildTypedSetupScriptCommand(scriptEnvName: string, report: string): string {
  const script = [
    `if test -z "$${scriptEnvName}"`,
    `then ${report}`,
    `exit ${SETUP_SCRIPT_MISSING_STATUS}`,
    'fi',
    `eval "$${scriptEnvName}"`
  ].join('; ')
  return `bash -lc '${script}'`
}
