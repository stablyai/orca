import {
  getPowerShellEscapeNativeArgsFunction,
  quotePowerShellLiteral
} from '../../shell/launch/powershell-native-argument'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import { launchExecutableIs, readLaunchArguments, readLaunchPosition } from './launch-position'

const CLAUDE_EXECUTABLE = /^claude\.(?:exe|cmd|bat)$/i
const SCRIPT_HEAD = '& { param($orcaProgram); '
const INVOCATION = '& $orcaProgram @orcaNativeArgs'
const ESCAPE_FUNCTION = getPowerShellEscapeNativeArgsFunction({ inline: true })

// Quoted arguments reach the script block as strings, including flag names and empty arguments.
export function powerShellNativeLaunch(
  executable: string,
  args: readonly string[],
  before = '',
  prependArgs = '',
  after = ''
): string {
  const argv = [executable, ...args].map(quotePowerShellLiteral).join(' ')
  const escape =
    `if (-not (Test-Path Function:__OrcaEscapeNativeArgs)) { ${ESCAPE_FUNCTION} }; ` +
    `$orcaNativeArgs = @(__OrcaEscapeNativeArgs $orcaProgram (${prependArgs}@($args))); `
  return `${SCRIPT_HEAD}${before}${escape}${INVOCATION}${after} } ${argv}`
}

export function withPowerShellClaudeNativeArgs(command: string): string {
  if (!/claude/i.test(command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS))) {
    return command
  }
  const launch = readLaunchPosition(command, 'powershell')
  if (
    !launch ||
    !/[\\/]/.test(launch.executable) ||
    !launchExecutableIs(launch.executable, CLAUDE_EXECUTABLE)
  ) {
    return command
  }
  const args = readLaunchArguments(command, 'powershell', launch)
  return args && !args.includes('--%')
    ? command.slice(0, launch.invocationStart) + powerShellNativeLaunch(launch.executable, args)
    : command
}

export function unwrapPowerShellNativeLaunch(command: string): string {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  const start = prefix.indexOf(SCRIPT_HEAD)
  const invocation = prefix.indexOf(INVOCATION, start + SCRIPT_HEAD.length)
  if (
    start === -1 ||
    invocation === -1 ||
    (start !== 0 &&
      readLaunchPosition(`${prefix.slice(0, start)}& orca-native-launch`, 'powershell')
        ?.invocationStart !== start)
  ) {
    return command
  }
  const end = prefix.indexOf(" } '", invocation + INVOCATION.length)
  return end === -1 ? command : command.slice(end + 3)
}
