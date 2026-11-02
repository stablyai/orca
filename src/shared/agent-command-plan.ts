import { extractLeadingEnvAssignments } from './command-environment'
import {
  tokenizeCustomCommandTemplate,
  type CommandTemplateBackslash
} from './commit-message-prompt'

export function parseAgentCommand(
  defaultBinary: string,
  commandOverride: string | undefined,
  backslash: CommandTemplateBackslash = 'escape'
):
  | {
      ok: true
      binary: string
      prefixArgs: string[]
      env?: Record<string, string>
      divergesFromShell: boolean
    }
  | { ok: false; error: string } {
  const command = commandOverride?.trim()
  if (!command) {
    return { ok: true, binary: defaultBinary, prefixArgs: [], divergesFromShell: false }
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
  return {
    ok: true,
    binary,
    prefixArgs,
    ...(env ? { env } : {}),
    divergesFromShell: tokenized.spans.some((span) => span.divergesFromShell)
  }
}

export function planAgentBinary(...args: Parameters<typeof parseAgentCommand>) {
  const parsed = parseAgentCommand(...args)
  if (!parsed.ok) {
    return parsed
  }
  const { divergesFromShell: _divergesFromShell, ...plan } = parsed
  return plan
}
