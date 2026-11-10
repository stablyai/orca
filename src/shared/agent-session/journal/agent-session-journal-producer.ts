// Root means no producer id, never a matching value. First-write attribution survives revisions without linkage; all producers share one session timeline.

import type { NativeChatBlock } from '../../native-chat/native-chat-types'
import type {
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from './agent-session-journal-types'

/** Check presence, not truthiness: unresolved child IDs must not become root. Pre-linkage rows lack an ID and retain their historical root attribution. */
export function isRootAgentJournalItem(
  item: Pick<AgentJournalRenderItem, 'agentId'> | undefined
): boolean {
  return agentJournalItemSubagentId(item) === null
}

type ProducerItem = AgentJournalProducerLinkage & {
  blocks?: readonly NativeChatBlock[]
  body?: AgentJournalRenderItem['body']
}

/** The subagent section for a row, or null when the session's own agent produced it.
 *  Same reading of absence as {@link isRootAgentJournalItem}. */
export function agentJournalItemSubagentId(item: ProducerItem | undefined): string | null {
  const blocks = item?.blocks ?? (item?.body?.kind === 'message' ? item.body.blocks : [])
  if (
    item?.agentId !== undefined &&
    item.producerKind === 'background' &&
    item.parentAgentId !== undefined &&
    blocks.some((block) => block.type === 'background-task' && block.taskId === item.agentId)
  ) {
    return item.parentAgentId
  }
  return item?.agentId ?? null
}

/** Any linkage member marks attribution; revisions omitting all members retain the existing producer. */
export function namesAgentJournalProducer(linkage: AgentJournalProducerLinkage): boolean {
  return (
    linkage.agentId !== undefined ||
    linkage.parentAgentId !== undefined ||
    linkage.providerParentRef !== undefined ||
    linkage.producerKind !== undefined ||
    linkage.attempt !== undefined
  )
}

/** Omit absent linkage members instead of setting undefined; spreading this carries future fields through every hop. */
export function agentJournalLinkageFields(
  linkage: AgentJournalProducerLinkage | undefined
): AgentJournalProducerLinkage {
  if (!linkage) {
    return {}
  }
  return {
    ...(linkage.agentId === undefined ? {} : { agentId: linkage.agentId }),
    ...(linkage.parentAgentId === undefined ? {} : { parentAgentId: linkage.parentAgentId }),
    ...(linkage.providerParentRef === undefined
      ? {}
      : { providerParentRef: linkage.providerParentRef }),
    ...(linkage.producerKind === undefined ? {} : { producerKind: linkage.producerKind }),
    ...(linkage.attempt === undefined ? {} : { attempt: linkage.attempt })
  }
}
