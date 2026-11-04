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
  // A custom Command can hide Pi behind any shell, so any inline key text there is refused.
  if (command?.includes('--api-key')) {
    return true
  }
  const argTokens = tokenizeStartupCommand(agentArgs?.trim() ?? '', shell)
  return (
    !argTokens.ok ||
    (lastPiOptionValue(argTokens.tokens, '--api-key') !== undefined &&
      !lastPiOptionValue(argTokens.tokens, '--provider')?.trim())
  )
}
