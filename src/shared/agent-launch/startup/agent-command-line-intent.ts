import { inferLaunchShell, readLaunchPosition } from './launch-position'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import {
  COMMAND_TOKEN_SCAN_MAX_CHARS,
  getCommandTokenPathBasename
} from '../../shell/command-resolution/command-token-scanner'
import {
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from '../../agent-status/process/agent-process-recognition'

const SLEEP_PREFIX =
  /^[ \t]*(?:sleep|\/bin\/sleep|\/usr\/bin\/sleep)[ \t]+(?:\d+(?:\.\d+)?|\.\d+)[smhd]?[ \t]*&&[ \t]*/

const POWERSHELL_CALL_PREFIX = /^[ \t]*&[ \t]+(?=["'])/

/** Launch preparation hint only; the shell still receives the complete command. */
export function extractAgentLaunchCommand(command: string): string {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  let offset = 0
  while (offset < prefix.length) {
    const match = SLEEP_PREFIX.exec(prefix.slice(offset))
    if (!match) {
      break
    }
    offset += match[0].length
  }
  // PowerShell runs a quoted program path, such as Orca's own copy, through its call operator.
  const call = POWERSHELL_CALL_PREFIX.exec(prefix.slice(offset))
  return command.slice(offset + (call?.[0].length ?? 0))
}

export function getAgentLaunchCommandToken(
  command: string | null | undefined,
  shell?: AgentStartupShell
): string {
  const text = command ?? ''
  if (shell) {
    const launch = shell === 'posix' ? extractAgentLaunchCommand(text) : text
    return readLaunchPosition(launch, shell)?.executable ?? ''
  }
  const dialect = inferLaunchShell(text)
  const launch = dialect === 'posix' ? extractAgentLaunchCommand(text) : text
  return readLaunchPosition(launch, dialect)?.executable ?? ''
}

/** Lowercased executable basename without a Windows/shell launcher extension. */
export function getAgentLaunchExecutableName(command: string | null | undefined): string {
  return getCommandTokenPathBasename(getAgentLaunchCommandToken(command))
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1|sh)$/, '')
}

/** Launch intent may include shell prefixes; process-table readers use the strict matcher. */
export function recognizeAgentLaunchCommand(
  commandLine: string | null | undefined,
  options?: Parameters<typeof recognizeAgentProcessFromCommandLine>[1]
): RecognizedAgentProcess | null {
  const text = commandLine ?? ''
  const dialect = inferLaunchShell(text)
  const command = dialect === 'posix' ? extractAgentLaunchCommand(text) : text
  const launch = readLaunchPosition(command, dialect)
  return recognizeAgentProcessFromCommandLine(
    launch && /[\\/]/.test(launch.executable)
      ? getCommandTokenPathBasename(launch.executable) + command.slice(launch.end)
      : extractAgentLaunchCommand(text),
    options
  )
}
