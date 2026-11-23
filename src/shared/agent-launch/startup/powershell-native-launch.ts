import {
  getPowerShellEscapeNativeArgsFunction,
  quotePowerShellLiteral
} from '../../shell/launch/powershell-native-argument'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import { readLaunchArguments, readLaunchPosition, type LaunchPosition } from './launch-position'

const SCRIPT_HEAD = /& \{ (\$orcaProgram = |param\(\$orcaProgram\); )/
const SCRIPT_END = ' } --'
const INVOCATION = '& $orcaProgram @orcaNativeArgs'
const ESCAPE_FUNCTION = getPowerShellEscapeNativeArgsFunction({ inline: true })

export function powerShellNativeLaunch(
  command: string,
  launch: LaunchPosition,
  before = '',
  prependArgs = '',
  after = ''
): string {
  const args = readLaunchArguments(command, 'powershell', launch)
  if (command.includes('--%', launch.end) && (args?.includes('--%') ?? true)) {
    return command
  }
  // A native program gets a bare a,b as one argument, but a script block gets an array: quote literal argv.
  const suffix =
    args && command.includes(',', launch.end)
      ? args.map((arg) => ` ${quotePowerShellLiteral(arg)}`).join('')
      : command.slice(launch.end)
  const escape = `if (-not (Test-Path Function:__OrcaEscapeNativeArgs)) { ${ESCAPE_FUNCTION} }; $orcaNativeArgs = @(__OrcaEscapeNativeArgs $orcaProgram (${prependArgs}@($args))); `
  // PowerShell consumes the first -- for a script block, preserving later -- and leaving flags unbound.
  const program = quotePowerShellLiteral(launch.executable)
  return `${command.slice(0, launch.invocationStart)}& { $orcaProgram = ${program}; ${before}${escape}${INVOCATION}${after}${SCRIPT_END}${suffix}`
}

export function unwrapPowerShellNativeLaunch(command: string): string {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  const head = SCRIPT_HEAD.exec(prefix)
  if (!head) {
    return command
  }
  const start = head.index
  const programStart = start + head[0].length
  const invocation = prefix.indexOf(INVOCATION, programStart)
  if (
    invocation === -1 ||
    (start !== 0 &&
      readLaunchPosition(`${prefix.slice(0, start)}& orca-native-launch`, 'powershell')
        ?.invocationStart !== start)
  ) {
    return command
  }
  const afterInvocation = invocation + INVOCATION.length
  if (head[1] === 'param($orcaProgram); ') {
    const legacyEnd = prefix.indexOf(" } '", afterInvocation)
    return legacyEnd === -1 ? command : command.slice(legacyEnd + 3)
  }
  const end = prefix.indexOf(SCRIPT_END, afterInvocation)
  const program = readLaunchPosition(prefix.slice(programStart), 'powershell')
  return end !== -1 && program
    ? command.slice(programStart, programStart + program.end) +
        command.slice(end + SCRIPT_END.length)
    : command
}
