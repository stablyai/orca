import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../failures/agent-session-failure'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'

/** Why one turn failed, from its own newest root failure row; a retry in progress is not why. */
export function structuredAgentSessionTurnFailure(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): AgentSessionFailureFact | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    if (
      item?.turnScope?.kind === 'turn' &&
      item.turnScope.turnItemId === turnItemId &&
      isRootAgentJournalItem(item) &&
      body?.kind === 'status' &&
      body.failure &&
      body.failure.kind !== 'providerRetrying'
    ) {
      return readAgentSessionFailureFact(body.failure)
    }
  }
  return undefined
}
