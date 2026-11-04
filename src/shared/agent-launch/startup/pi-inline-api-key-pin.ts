import { agentRequiredValueOptions } from '../../agent-session/options/agent-session-option-agent-args'
import { findOptionOccurrence } from '../../command-option-occurrence'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

/** Pi sends an inline key to the selected model's provider unless `--provider` pins it. */
export function piInlineApiKeyIsUnpinned(
  launchTexts: readonly (string | null | undefined)[],
  shell: AgentStartupShell
): boolean {
  const parsed = launchTexts.map((text) => tokenizeStartupCommand(text?.trim() ?? '', shell))
  if (parsed.some((result) => !result.ok)) {
    return true
  }
  const has = (alias: string) =>
    parsed.some((result) => {
      const tokens = result.ok ? result.tokens : []
      const found = findOptionOccurrence(tokens, [alias], true, agentRequiredValueOptions('pi'))
      return found !== null && tokens[found.index] === alias
    })
  return has('--api-key') && !has('--provider')
}
