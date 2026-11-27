import {
  CODEX_KITTY_WINDOW_ID,
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE
} from '../../terminal/images/terminal-image-protocol'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import { readLaunchPosition, type LaunchPosition } from './launch-position'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export const POSIX_CODEX_IMAGE_HINT = `if [ "$${ORCA_IMAGE_PROTOCOL_ENV}" = ${ORCA_IMAGE_PROTOCOL_VALUE} ] && [ -z "\${KITTY_WINDOW_ID+x}" ]; then export KITTY_WINDOW_ID=${CODEX_KITTY_WINDOW_ID}; fi`
export const POWERSHELL_CODEX_IMAGE_HINT = `$orcaKitty = $env:${ORCA_IMAGE_PROTOCOL_ENV} -ceq '${ORCA_IMAGE_PROTOCOL_VALUE}' -and -not (Test-Path Env:KITTY_WINDOW_ID); if ($orcaKitty) { $env:KITTY_WINDOW_ID = '${CODEX_KITTY_WINDOW_ID}' }; `
export const POWERSHELL_CLEAR_CODEX_IMAGE_HINT =
  'if ($orcaKitty) { Remove-Item Env:KITTY_WINDOW_ID }'

const POSIX_PREFIX = `/bin/sh -c ${quoteStartupArg(
  `${POSIX_CODEX_IMAGE_HINT}; exec "$@"`,
  'posix'
)} orca-codex `
const POWERSHELL_PREFIX = `& { ${POWERSHELL_CODEX_IMAGE_HINT}try { `
const POWERSHELL_SUFFIX = ` } finally { ${POWERSHELL_CLEAR_CODEX_IMAGE_HINT} } }`

export function withCodexScopedImageCommand(
  command: string,
  shell: AgentStartupShell,
  launch: LaunchPosition
): string {
  // cmd has no interactive setlocal scope.
  if (shell === 'cmd' || /[\r\n]/.test(command)) {
    return command
  }
  const args = tokenizeStartupCommand(command.slice(launch.end), shell)
  if (!args.ok || args.spans.some((span) => span.divergesFromShell)) {
    return command
  }
  if (shell === 'powershell') {
    // Keep the original invocation inside the scope so PowerShell parses native arguments directly.
    if (launch.executable.toLowerCase() === 'codex' || args.tokens.includes('--%')) {
      return command
    }
    const callOperator = !launch.hasCallOperator && `'"`.includes(command[launch.start]) ? '& ' : ''
    return (
      command.slice(0, launch.invocationStart) +
      POWERSHELL_PREFIX +
      callOperator +
      command.slice(launch.invocationStart) +
      POWERSHELL_SUFFIX
    )
  }
  return command.slice(0, launch.start) + POSIX_PREFIX + command.slice(launch.start)
}

export function unwrapCodexScopedImageCommand(command: string): string {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  if (prefix.includes(POSIX_PREFIX)) {
    const start = readLaunchPosition(prefix, 'posix')?.start
    if (start !== undefined && prefix.startsWith(POSIX_PREFIX, start)) {
      return command.slice(start + POSIX_PREFIX.length)
    }
  }
  const start = prefix.indexOf(POWERSHELL_PREFIX)
  if (
    start !== -1 &&
    command.endsWith(POWERSHELL_SUFFIX) &&
    (start === 0 ||
      readLaunchPosition(`${prefix.slice(0, start)}& codex`, 'powershell')?.invocationStart ===
        start)
  ) {
    const invocation = command.slice(start + POWERSHELL_PREFIX.length, -POWERSHELL_SUFFIX.length)
    const launch = readLaunchPosition(invocation, 'powershell')
    return launch ? invocation.slice(launch.start) : command
  }
  return command
}
