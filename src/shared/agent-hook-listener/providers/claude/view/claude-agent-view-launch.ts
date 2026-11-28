import { findClaudeExecutableIndex } from '../../../../agent-launch/startup/agent-resume-launch-command'
import { withArgsAfterAgentExecutable } from '../../../../agent-launch/startup/agent-executable-args'
import {
  quoteStartupArg,
  type AgentStartupShell
} from '../../../../agent-launch/startup/tui-agent-startup-shell'

export function withClaudeAgentViewPlugin(
  command: string,
  root: string,
  shell: AgentStartupShell
): string {
  return (
    withArgsAfterAgentExecutable(
      command,
      shell,
      findClaudeExecutableIndex,
      ` --plugin-dir ${quoteStartupArg(root, shell)}`
    ) ?? command
  )
}
