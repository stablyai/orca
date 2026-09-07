import { resolveCanonicalPaneAgentIdentity } from '../../../../shared/pane-agent-identity-adapter'
import { resolveExplicitTerminalTitleAgentType } from '../../../../shared/terminal-title-agent-type'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStatus } from '../../../../shared/agent-detection'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'

/** Attribute title activity through the canonical identity ladder. */
export function resolveAttributedTitleStatus(
  title: string,
  launchAgent?: TuiAgent | null
): AgentStatus | null {
  return resolveCanonicalPaneAgentIdentity({
    launchAgent: launchAgent ?? null,
    title,
    uncoveredFallback: { agent: resolveExplicitTerminalTitleAgentType(title), titleOnly: true }
  }).agent !== null
    ? classifyTitleActivity(title)
    : null
}
