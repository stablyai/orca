import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import {
  COMMAND_TOKEN_SCAN_MAX_CHARS,
  getCommandTokenPathBasename
} from '../../../../shared/command-token-scanner'
import { getAgentLaunchCommandToken } from '../../../../shared/agent-command-line-intent'

const TERMINAL_STARTUP_COMMAND_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i
// Why: startup commands can carry pasted scripts; classifier work should stay bounded.
export const TERMINAL_STARTUP_COMMAND_TOKEN_MAX_CHARS = COMMAND_TOKEN_SCAN_MAX_CHARS

const KNOWN_TUI_AGENT_EXECUTABLES = new Set<string>()

for (const config of Object.values(TUI_AGENT_CONFIG)) {
  for (const candidate of [
    config.detectCmd,
    config.expectedProcess,
    ...getTuiAgentDetectCommands(config)
  ]) {
    const executable = normalizeTerminalStartupCommandExecutableName(candidate)
    if (executable) {
      KNOWN_TUI_AGENT_EXECUTABLES.add(executable)
    }
  }
}

export function isKnownTuiAgentTerminalStartupCommand(command: string): boolean {
  const executable = getTerminalStartupCommandExecutableName(command)
  return (
    KNOWN_TUI_AGENT_EXECUTABLES.has(executable) ||
    executable.startsWith('codex-') ||
    executable.startsWith('grok-') ||
    executable.startsWith('muse-bin-')
  )
}

function getTerminalStartupCommandExecutableName(command: string): string {
  const token = getAgentLaunchCommandToken(command)
  return normalizeTerminalStartupCommandExecutableName(getCommandTokenPathBasename(token))
}

function normalizeTerminalStartupCommandExecutableName(executable: string): string {
  return executable.toLowerCase().replace(TERMINAL_STARTUP_COMMAND_EXTENSION_RE, '')
}
