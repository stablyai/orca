import {
  tokenizeCustomCommandTemplate,
  type CommandTemplateBackslash
} from './commit-message-prompt'
import { applyDetectedTuiAgentExecutable } from './detected-agent-command'
import type { AgentExecutionRuntime } from './detected-agent-executables'
import type { TuiAgent } from './tui-agent'

export function planAgentBinary(
  defaultBinary: string,
  commandOverride: string | undefined,
  backslash: CommandTemplateBackslash = 'escape',
  agent?: TuiAgent,
  runtime?: AgentExecutionRuntime
): { ok: true; binary: string; prefixArgs: string[] } | { ok: false; error: string } {
  const command = commandOverride?.trim()
  if (!command) {
    // Why: an alias-only install (Cursor.app's `cursor`, no `cursor-agent`) reaches
    // the same CLI through a subcommand, so the default binary may expand to
    // multiple tokens once the detected executable is applied.
    const [binary, ...prefixArgs] = (
      agent ? applyDetectedTuiAgentExecutable(agent, defaultBinary, runtime) : defaultBinary
    ).split(' ')
    return { ok: true, binary: binary ?? defaultBinary, prefixArgs }
  }

  const tokenized = tokenizeCustomCommandTemplate(command, backslash)
  if (!tokenized.ok) {
    return { ok: false, error: `Agent command override is invalid: ${tokenized.error}` }
  }
  const [binary, ...prefixArgs] = tokenized.tokens
  if (!binary) {
    return { ok: false, error: 'Agent command override must start with a binary name.' }
  }
  return { ok: true, binary, prefixArgs }
}
