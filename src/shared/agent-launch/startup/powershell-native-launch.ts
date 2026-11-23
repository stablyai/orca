import {
  getPowerShellEscapeNativeArgsFunction,
  quotePowerShellLiteral
} from '../../shell/launch/powershell-native-argument'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shell/command-resolution/command-token-scanner'
import { readLaunchArguments, readLaunchPosition, type LaunchPosition } from './launch-position'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

const SCRIPT_HEAD = /& \{ (\$orcaProgram = |param\(\$orcaProgram\); )/
const SCRIPT_END = ' } --'
const INVOCATION = '& $orcaProgram @orcaNativeArgs'
const ESCAPE_FUNCTION = getPowerShellEscapeNativeArgsFunction({ inline: true })
const QUOTE_OR_EXPRESSION = /['"`$@\u2018-\u201E]/

/** Plain words only, so each span is its own value; a quoted a,b is already one argument. */
function quoteCommaWords(tail: string): string | null {
  const parsed = tokenizeStartupCommand(tail, 'powershell', true)
  if (!parsed.ok) {
    return null
  }
  let out = ''
  let end = 0
  for (const span of parsed.spans) {
    if (tail.slice(span.start, span.end).includes(',')) {
      out += tail.slice(end, span.start) + quotePowerShellLiteral(tail.slice(span.start, span.end))
      end = span.end
    }
  }
  return out + tail.slice(end)
}

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
  // A native program gets a bare a,b as one argument but a script block gets an array. Quote plain
  // comma words; leave mixed quoting to PowerShell's own native parsing, unwrapped like --%.
  const tail = command.slice(launch.end)
  const suffix = !tail.includes(',')
    ? tail
    : args && !QUOTE_OR_EXPRESSION.test(tail)
      ? quoteCommaWords(tail)
      : null
  if (suffix === null) {
    return command
  }
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
