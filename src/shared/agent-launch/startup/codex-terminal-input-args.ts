import type { TuiAgent } from '../catalog/tui-agent'
import { isAgentExecutableToken } from './agent-executable-args'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/** Generated Codex invocations disable paste-burst on hosts where Orca brackets every paste. */
export function withAgentTerminalInputArgs(
  command: string,
  agent: TuiAgent,
  platform: NodeJS.Platform | null,
  shell: AgentStartupShell
): string {
  if (
    agent !== 'codex' ||
    platform === null ||
    platform === 'win32' ||
    command.length > 32_767 ||
    /[\r\n]/.test(command) ||
    command.includes('disable_paste_burst')
  ) {
    return command
  }
  // The recipe may be old. Only append to a single direct invocation, before any prompt separator.
  const invocation = shell === 'powershell' ? command.replace(/^[ \t]*&[ \t]+/, '') : command
  const parsed = tokenizeStartupCommand(invocation, shell, true)
  const [program] = parsed.ok ? parsed.tokens : []
  if (
    !program ||
    !isAgentExecutableToken(program, ['codex']) ||
    !parsed.ok ||
    parsed.tokens.includes('--') ||
    parsed.spans.some(
      (span) => span.divergesFromShell || (shell === 'powershell' && invocation[span.start] === '@')
    )
  ) {
    return command
  }
  return `${command} ${quoteStartupArg('-c', shell)} ${quoteStartupArg('disable_paste_burst=true', shell)}`
}
