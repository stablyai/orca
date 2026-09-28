import { extractLeadingEnvAssignments } from './command-environment'
import {
  tokenizeCustomCommandTemplate,
  type CommandTemplateBackslash
} from './commit-message-prompt'

export function planAgentBinary(
  defaultBinary: string,
  commandOverride: string | undefined,
  backslash: CommandTemplateBackslash = 'escape'
):
  | { ok: true; binary: string; prefixArgs: string[]; env?: Record<string, string> }
  | { ok: false; error: string } {
  const command = commandOverride?.trim()
  if (!command) {
    return { ok: true, binary: defaultBinary, prefixArgs: [] }
  }

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
