import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import { spelledProviderTimelineItemKey } from './provider-timeline-item-key'

export const AGENT_SESSION_COMPACTION_SKIPPED_PRESENTATION = 'compaction-skipped'

/** Older OMP outcomes carried their meaning in the host's reserved item identity. */
export function isAgentSessionLegacyCompactionResult(itemId: string): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return (
    identity?.provider === 'legacy' &&
    identity.agent === 'omp' &&
    spelledProviderTimelineItemKey(identity.recordId)?.startsWith('compaction%3Acompact%3A') ===
      true
  )
}
