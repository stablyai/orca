import { findClaudeExecutableIndex } from './agent-resume-launch-command'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export function withClaudeAgentViewPlugin(
  command: string,
  root: string,
  shell: AgentStartupShell
): string {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return command
  }
  const index = findClaudeExecutableIndex(parsed.tokens, shell)
  if (
    index < 0 ||
    parsed.tokens
      .slice(0, index)
      .some(
        (token, at) =>
          !(
            (shell === 'posix' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ||
            (shell === 'powershell' && at === 0 && token === '&')
          )
      )
  ) {
    return command
  }
  for (let i = 0; i <= parsed.tokens.length; i++) {
    const start = i === 0 ? 0 : parsed.spans[i - 1].end
    const end = i === parsed.tokens.length ? command.length : parsed.spans[i].start
    if (!/^[ \t]*$/.test(command.slice(start, end))) {
      return command
    }
    if (
      i < parsed.tokens.length &&
      parsed.spans[i].divergesFromShell &&
      !(shell === 'powershell' && i === 0 && parsed.tokens[i] === '&')
    ) {
      return command
    }
  }
  const end = parsed.spans[index].end
  return `${command.slice(0, end)} --plugin-dir ${quoteStartupArg(root, shell)}${command.slice(end)}`
}
