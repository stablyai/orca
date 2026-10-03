import { useEffect, useMemo, useRef } from 'react'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import {
  sameAgentSessionFailureFact,
  structuredAgentSessionStartFailureFacts
} from '../../../../shared/structured-agent-session-recorded-rejection-words'

const NO_FACTS: readonly AgentSessionFailureFact[] = []

/** What the loaded start-failure rows state, read only while `enabled`. Held while unchanged, so a
 *  streaming turn does not rebuild every row's delivery notice. */
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
  // Written after commit, so render stays pure.
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}
