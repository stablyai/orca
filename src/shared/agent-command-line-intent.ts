import {
  COMMAND_TOKEN_SCAN_MAX_CHARS,
  getCommandTokenPathBasename,
  getFirstCommandToken
} from './command-token-scanner'
import {
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from './agent-process-recognition'

const SLEEP_PREFIX =
  /^[ \t]*(?:sleep|\/bin\/sleep|\/usr\/bin\/sleep)[ \t]+(?:\d+(?:\.\d+)?|\.\d+)[smhd]?[ \t]*&&[ \t]*/

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
  return command.slice(offset)
}

export function getAgentLaunchCommandToken(command: string | null | undefined): string {
  return getFirstCommandToken(extractAgentLaunchCommand(command ?? ''))
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
  return recognizeAgentProcessFromCommandLine(extractAgentLaunchCommand(commandLine ?? ''), options)
}
