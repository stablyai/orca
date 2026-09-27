import { extractLeadingEnvAssignments } from './command-environment'
import {
  tokenizeCustomCommandTemplate,
  type CommandTemplateBackslash
} from './commit-message-prompt'

type AgentBinaryPlan =
  | { ok: true; binary: string; prefixArgs: string[]; env?: Record<string, string> }
  | { ok: false; error: string }

export function planAgentBinary(
  defaultBinary: string,
  commandOverride: string | undefined,
  backslash: CommandTemplateBackslash = 'escape'
): AgentBinaryPlan {
  const command = commandOverride?.trim()
  return command
    ? planAgentCommand(command, backslash)
    : { ok: true, binary: defaultBinary, prefixArgs: [] }
}

/** Splits a typed agent command into leading `NAME=value` env, the binary, and its fixed args. */
export function planAgentCommand(
  command: string,
  backslash: CommandTemplateBackslash = 'escape'
): AgentBinaryPlan {
  const tokenized = tokenizeCustomCommandTemplate(command, backslash)
  if (!tokenized.ok) {
    return { ok: false, error: `Agent command override is invalid: ${tokenized.error}` }
  }
  const { env, rest } = extractLeadingEnvAssignments(tokenized.tokens)
  const [binary, ...prefixArgs] = rest
  if (!binary) {
    return { ok: false, error: 'Agent command override must start with a binary name.' }
  }
  return { ok: true, binary, prefixArgs, ...(env ? { env } : {}) }
}
