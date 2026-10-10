import { useEffect, useMemo, useRef } from 'react'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  sameAgentSessionFailureFact,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'

const NO_FACTS: readonly AgentSessionFailureFact[] = []

/** Loaded failure facts stay shared while unchanged; startup observation waits for a startup row. */
export function useStructuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[],
  enabled: boolean,
  observeStarts = false
): readonly AgentSessionFailureFact[] {
  const facts = useMemo(
    () =>
      enabled ||
      (observeStarts && items.some((item) => isStructuredAgentSessionStartFailureRow(item.itemId)))
        ? structuredAgentSessionStartFailureFacts(items)
        : NO_FACTS,
    [enabled, observeStarts, items]
  )
  const previousRef = useRef<readonly AgentSessionFailureFact[]>(NO_FACTS)
  const previous = previousRef.current
  const stable =
    previous.length === facts.length &&
    previous.every((fact, index) => sameAgentSessionFailureFact(fact, facts[index]))
      ? previous
      : facts
  // Written after commit, so render stays pure.
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}
