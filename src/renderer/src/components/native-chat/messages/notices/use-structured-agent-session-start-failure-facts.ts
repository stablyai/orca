import { useEffect, useMemo, useRef } from 'react'
import type { AgentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  sameAgentSessionFailureFact,
  agentSessionVisibleFailureFacts
} from '../../../../../../shared/agent-session/failures/agent-session-visible-failures'
import { rowsBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

const NO_FACTS: readonly AgentSessionFailureFact[] = []

/** Read start failures only while enabled; retain unchanged facts so streaming cannot rebuild delivery notices. */
export function useStructuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[],
  enabled: boolean
): readonly AgentSessionFailureFact[] {
  // Failures are status rows, so a streamed reply's text revision keeps the last scan.
  const rows = rowsBesideStreamedText(items)
  const facts = useMemo(
    () => (enabled ? agentSessionVisibleFailureFacts(rows) : NO_FACTS),
    [enabled, rows]
  )
  const previousRef = useRef<readonly AgentSessionFailureFact[]>(NO_FACTS)
  const previous = previousRef.current
  const stable =
    previous.length === facts.length &&
    previous.every((fact, index) => sameAgentSessionFailureFact(fact, facts[index]))
      ? previous
      : facts
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}
