import { agentRequiredValueOptions } from '../../agent-session/options/agent-session-option-agent-args'
import { findOptionOccurrence } from '../../command-option-occurrence'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

/** Pi keeps the last value of an option; undefined when the option is absent. */
function lastPiOptionValue(tokens: readonly string[], alias: string): string | undefined {
  let value: string | undefined
  const find = (start: number) =>
    findOptionOccurrence(tokens, [alias], true, agentRequiredValueOptions('pi'), start, 'required')
  for (let found = find(0); found; found = find(found.index + found.consumed)) {
    value = tokens[found.index] === alias ? (found.value ?? '') : value
  }
  return value
}

/** Pi sends an inline key to the selected model's provider unless a non-empty --provider pins it. */
export function piInlineApiKeyIsUnpinned(
  command: string | undefined,
  agentArgs: string | null | undefined,
  shell: AgentStartupShell
): boolean {
  const commandTokens = tokenizeStartupCommand(command?.trim() ?? '', shell)
  const argTokens = tokenizeStartupCommand(agentArgs?.trim() ?? '', shell)
  if (!commandTokens.ok || !argTokens.ok) {
    return true
  }
  // A custom Command's shell scope is unknowable, so any inline key there is refused.
  if (commandTokens.tokens.some((token) => token.startsWith('--api-key'))) {
    return true
  }
  return (
    lastPiOptionValue(argTokens.tokens, '--api-key') !== undefined &&
    !lastPiOptionValue(argTokens.tokens, '--provider')?.trim()
  )
}
