import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'

const TERMINAL_STARTUP_COMMAND_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i
// Why: startup commands can carry pasted scripts; classifier work should stay bounded.
export const TERMINAL_STARTUP_COMMAND_TOKEN_MAX_CHARS = 4096

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

export function getTerminalStartupCommandToken(command: string): string {
  const scanLimit = Math.min(command.length, TERMINAL_STARTUP_COMMAND_TOKEN_MAX_CHARS)
  let index = 0

  while (index < scanLimit && isTerminalStartupCommandWhitespace(command.charCodeAt(index))) {
    index += 1
  }
  if (index >= scanLimit) {
    return ''
  }

  const quote = command[index]
  if ((quote === '"' || quote === "'") && index + 1 < scanLimit) {
    const quotedTokenStart = index + 1
    for (let end = quotedTokenStart; end < scanLimit; end += 1) {
      if (command[end] === quote) {
        if (end > quotedTokenStart) {
          return command.slice(quotedTokenStart, end)
        }
        break
      }
    }
  }

  const tokenStart = index
  while (index < scanLimit && !isTerminalStartupCommandWhitespace(command.charCodeAt(index))) {
    index += 1
  }
  return command.slice(tokenStart, index)
}

export function isCodexTerminalStartupCommand(command: string): boolean {
  const executable = getTerminalStartupCommandExecutableName(command)
  return executable === 'codex' || executable.startsWith('codex-')
}

export function isKnownTuiAgentTerminalStartupCommand(command: string): boolean {
  const executable = getTerminalStartupCommandExecutableName(command)
  return (
    KNOWN_TUI_AGENT_EXECUTABLES.has(executable) ||
    executable.startsWith('codex-') ||
    executable.startsWith('grok-')
  )
}

function getTerminalStartupCommandExecutableName(command: string): string {
  const token = getTerminalStartupCommandToken(command)
  const segmentStart = getTerminalStartupCommandPathSegmentStart(token)
  return normalizeTerminalStartupCommandExecutableName(token.slice(segmentStart))
}

function normalizeTerminalStartupCommandExecutableName(executable: string): string {
  return executable.toLowerCase().replace(TERMINAL_STARTUP_COMMAND_EXTENSION_RE, '')
}

function getTerminalStartupCommandPathSegmentStart(token: string): number {
  for (let index = token.length - 1; index >= 0; index -= 1) {
    const code = token.charCodeAt(index)
    if (code === 47 || code === 92) {
      return index + 1
    }
  }
  return 0
}

function isTerminalStartupCommandWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}
