import { useEffect, useMemo, useRef } from 'react'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import {
  sameAgentSessionFailureFact,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'

const NO_FACTS: readonly AgentSessionFailureFact[] = []

/** Read start failures only while enabled; retain unchanged facts so streaming cannot rebuild delivery notices. */
export function useStructuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[],
  enabled: boolean
): readonly AgentSessionFailureFact[] {
  const facts = useMemo(
    () => (enabled ? structuredAgentSessionStartFailureFacts(items) : NO_FACTS),
    [enabled, items]
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
