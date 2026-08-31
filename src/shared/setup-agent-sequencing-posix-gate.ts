import {
  SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  setupStartedPath
} from './setup-agent-sequencing-env'

/** Shell fragments for the POSIX half of the setup-to-agent gate: the setup launch that records
 *  an outcome, and the agent launch that waits for one. */
export function buildPosixSetupCommand(bareRunnerCommand: string): string {
  const script = [
    `if [ -n "\${${SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV}:-}" ]; then`,
    `eval "\$${SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV}";`,
    'else',
    `${bareRunnerCommand};`,
    'fi'
  ].join(' ')
  return `bash -lc ${quotePosixArg(script)}`
}

export function buildPosixSetupScript(
  setupCommand: string,
  markerPath: string,
  nonce: string
): string {
  const marker = quotePosixArg(markerPath)
  const tmp = quotePosixArg(`${markerPath}.tmp`)
  const started = quotePosixArg(setupStartedPath(markerPath))
  const nonceValue = quotePosixArg(nonce)

  // Why: the gate's only evidence is this file, so the status is recorded from an EXIT trap —
  // a runner that is interrupted, killed, or exits non-zero still records an outcome instead of
  // leaving the agent terminal waiting on a marker nobody will ever write.
  return [
    `rm -f ${marker} ${tmp} ${started} 2>/dev/null`,
    `printf '%s\\n' ${nonceValue} > ${started} 2>/dev/null`,
    `orca_record_setup_status() { printf '%s:%s\\n' ${nonceValue} "$1" > ${tmp} 2>/dev/null && mv -f ${tmp} ${marker} 2>/dev/null; }`,
    'trap \'orca_record_setup_status "$?"\' EXIT',
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    `( ${setupCommand} )`,
    'exit "$?"'
  ].join('; ')
}

export function buildPosixStartupScript(
  startupCommand: string,
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number,
  startGraceSeconds: number,
  progressIntervalSeconds: number
): string {
  const marker = quotePosixArg(markerPath)
  const tmp = quotePosixArg(`${markerPath}.tmp`)
  const started = quotePosixArg(setupStartedPath(markerPath))
  const nonceValue = quotePosixArg(nonce)
  const timeout = Math.max(1, Math.floor(waitTimeoutSeconds))
  const grace = Math.max(1, Math.floor(startGraceSeconds))
  const progressInterval = Math.max(1, Math.floor(progressIntervalSeconds))
  const launchAgent = buildPosixLaunchAgentClause(startupCommand)
  // Why: the PTY launch path feeds this command through an interactive shell,
  // so keeping the wrapper on one line avoids visible `quote>` continuation
  // prompts while still preserving valid `while`/`if` shell syntax.
  const script = [
    `deadline=$((SECONDS + ${timeout}));`,
    `start_deadline=$((SECONDS + ${grace}));`,
    `next_report=$((SECONDS + ${progressInterval}));`,
    'setup_started=0;',
    'echo "Waiting for setup to finish before starting agent..." >&2;',
    'while :; do',
    `if [ -f ${marker} ]; then`,
    `IFS=: read -r seen status < ${marker} || true;`,
    `if [ "$seen" = ${nonceValue} ]; then`,
    `rm -f ${marker} ${tmp} ${started} 2>/dev/null;`,
    `if [ "$status" = "0" ]; then ${launchAgent} fi;`,
    'echo "Setup failed; skipping agent startup. Setup exited with status ${status:-1}; open the Setup tab for its output, then start the agent yourself once it is fixed." >&2;',
    'exit "${status:-1}";',
    'fi;',
    'fi;',
    `if [ "$setup_started" = "0" ] && [ -f ${started} ]; then`,
    'setup_started=1;',
    'echo "Setup started; waiting for it to finish." >&2;',
    'fi;',
    'if [ "$setup_started" = "0" ] && [ "$SECONDS" -ge "$start_deadline" ]; then',
    // Why: no start evidence is not success evidence. Stop here rather than allowing an
    // unsequenced agent to run against an environment whose setup outcome is unknown.
    `echo "Setup never reported starting within ${grace}s; the agent was not started because setup could not be verified. Open the Setup tab and retry once setup is running." >&2;`,
    'exit 125;',
    'fi;',
    'if [ "$SECONDS" -ge "$deadline" ]; then',
    `echo "Timed out waiting for setup before starting agent. Waited ${timeout}s without a result; the agent was not started. Open the Setup tab for its output." >&2;`,
    'exit 124;',
    'fi;',
    'if [ "$SECONDS" -ge "$next_report" ]; then',
    `next_report=$((SECONDS + ${progressInterval}));`,
    'echo "Still waiting for setup to finish before starting agent... (${SECONDS}s elapsed)" >&2;',
    'fi;',
    'sleep 1;',
    'done'
  ].join(' ')

  return script
}

function buildPosixLaunchAgentClause(startupCommand: string): string {
  const startupSuccessCommand = buildPosixStartupSuccessCommand(startupCommand)
  return `if [ -n "\${${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}:-}" ]; then eval "\$${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}"; exit "$?"; else ${startupSuccessCommand}; fi;`
}

function buildPosixStartupSuccessCommand(startupCommand: string): string {
  if (
    hasUnquotedPosixCommandSeparator(startupCommand) ||
    hasLeadingPosixEnvAssignment(startupCommand)
  ) {
    return `eval ${quotePosixArg(startupCommand)}; exit "$?"`
  }
  return `exec ${startupCommand}`
}

function hasLeadingPosixEnvAssignment(command: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.trimStart())
}

function hasUnquotedPosixCommandSeparator(command: string): boolean {
  let quote: "'" | '"' | null = null
  let escaped = false
  for (const char of command) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n' || char === '\r') {
      return true
    }
  }
  return false
}

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}
