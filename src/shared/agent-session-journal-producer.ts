// Which agent produced a journal row, and the one place absence is interpreted.
//
// One journal is the durable record of one agent SESSION, and a session may run
// subagents. Both agents' rows land in the same timeline, so every "what is this
// agent doing right now" reader has to say which producer it means. Readers ask
// "is this NOT mine", never "is this mine": the session's own agent stamps
// nothing, so root-ness is the absence of an id rather than a value to match.

import type {
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from './agent-session-journal-types'

/**
 * Whether the session's own agent produced this row, rather than a subagent.
 *
 * Presence, not truthiness. An id that failed to resolve is still an id, and a
 * truthy test would read it as root and put the child's content back on the
 * parent — the defect this attribution exists to remove, reintroduced through a
 * soft predicate. Rows written before linkage existed carry no id and read as
 * root, which reproduces exactly what those journals always showed.
 */
export function isRootAgentJournalItem(
  item: Pick<AgentJournalRenderItem, 'agentId'> | undefined
): boolean {
  return item?.agentId == null
}

/** Linkage as row fields, with absent members omitted rather than set to
 *  `undefined`. Every carrier spreads this, so a new field reaches the row
 *  through one edit instead of one per hop. */
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
