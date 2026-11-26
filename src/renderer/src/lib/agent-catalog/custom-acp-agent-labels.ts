// Names of the custom ACP agents hosts advertised, so chats and menus show them by name.

import { isCustomAcpAgentId } from '../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { setConfiguredAgentLabelSource } from '../../../../shared/agent-status/presentation/agent-type-label'

const labels = new Map<string, string>()

/** Remembers each listed custom agent's name; a later list from any host renames it. */
export function rememberCustomAcpAgentLabels(
  rows: readonly { agent: string; label?: string }[]
): void {
  for (const { agent, label } of rows) {
    if (label && isCustomAcpAgentId(agent)) {
      labels.set(agent, label)
    }
  }
}

/** A custom agent's advertised name; null for a built-in or an agent no host has named yet. */
export function customAcpAgentLabel(agent: string): string | null {
  return labels.get(agent) ?? null
}

setConfiguredAgentLabelSource(customAcpAgentLabel)
