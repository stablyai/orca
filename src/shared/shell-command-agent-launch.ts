import { COMMAND_TOKEN_SCAN_MAX_CHARS } from './command-token-scanner'
import { recognizeAgentLaunchCommand } from './agent-launch/startup/agent-command-line-intent'
import { GENERIC_PROCESS_NAME_AGENTS } from './agent-status/process/agent-process-recognition'
import { splitUnquotedSegments } from './orca-cli-invocations'
import type { TerminalAgent } from './agent-status/identity/terminal-agent'

const LEADING_ENV_ASSIGNMENTS = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/

/** The agent CLI a background shell command runs (`cd x && agy -p ...`), so its row can show that agent instead of a shell. */
export function agentLaunchedByShellCommand(command: unknown): TerminalAgent | null {
  if (typeof command !== 'string') {
    return null
  }
  for (const segment of splitUnquotedSegments(command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS))) {
    const launch = segment.replace(LEADING_ENV_ASSIGNMENTS, '').replace(/^\s*\(\s*/, '')
    const agent = recognizeAgentLaunchCommand(launch, { includeHeadlessOneShot: true })?.agent
    // Generic names (orca, cn, acli) also belong to ordinary tools.
    if (agent && !GENERIC_PROCESS_NAME_AGENTS.has(agent)) {
      return agent
    }
  }
  return null
}
