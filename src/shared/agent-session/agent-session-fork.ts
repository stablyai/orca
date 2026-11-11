import type { AgentJournalRenderItem } from './journal/agent-session-journal-types'
import type { AgentSessionForkedFrom } from './lifecycle/agent-session-record'

/** The derived row after a fork's inherited history; clients draw it as a divider linking to the source. */
export const AGENT_SESSION_FORKED_FROM_PRESENTATION = 'forked-from'

/** Inherited rows belong to the original chat's action scope. */
export function isInheritedAgentSessionItem(
  items: readonly Pick<AgentJournalRenderItem, 'itemId'>[],
  boundary: AgentSessionForkedFrom['childBoundary'] | undefined,
  itemId: string
): boolean {
  if (boundary?.kind !== 'item') {
    return false
  }
  const anchor = items.findIndex((item) => item.itemId === boundary.itemId)
  const selected = items.findIndex((item) => item.itemId === itemId)
  return selected !== -1 && selected <= anchor
}
