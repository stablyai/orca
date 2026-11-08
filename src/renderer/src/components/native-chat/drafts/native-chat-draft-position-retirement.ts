import type { Tab } from '../../../../../shared/tab-types'
import { retireNativeChatDraftPosition } from './native-chat-composer-draft-memory'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from './native-chat-draft-scope'

/** A destination's death retires only its unsatisfied UI position, never its ordinary content. */
export function retireRemovedNativeChatDraftPositions(
  before: readonly Tab[],
  after: readonly Tab[]
): void {
  if (before === after) {
    return
  }
  const remaining = new Map(after.map((tab) => [tab.id, tab]))
  for (const tab of before) {
    const next = remaining.get(tab.id)
    if (
      tab.contentType === 'agent-session' &&
      (next?.contentType !== tab.contentType ||
        next.entityId !== tab.entityId ||
        next.executionHostId !== tab.executionHostId)
    ) {
      retireNativeChatDraftPosition(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId)),
        tab.id
      )
    }
  }
}
