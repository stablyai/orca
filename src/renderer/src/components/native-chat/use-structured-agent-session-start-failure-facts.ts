import { useEffect, useMemo, useRef } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { sameAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import {
  structuredAgentSessionStartFailureFacts,
  type StatedStartFailure
} from './structured-agent-session-delivery-notices'

const NO_FACTS: readonly StatedStartFailure[] = []

/** What the loaded start-failure rows state, read only while `enabled`. Held while unchanged, so a
 *  streaming turn does not rebuild every row's delivery notice. */
export function useStructuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[],
  enabled: boolean
): readonly StatedStartFailure[] {
  const facts = useMemo(
    () => (enabled ? structuredAgentSessionStartFailureFacts(items) : NO_FACTS),
    [enabled, items]
  )
  const previousRef = useRef<readonly StatedStartFailure[]>(NO_FACTS)
  const previous = previousRef.current
  const stable =
    previous.length === facts.length &&
    previous.every((stated, index) => {
      const next = facts[index]
      return (
        next !== undefined &&
        stated.itemId === next.itemId &&
        stated.ofCommand === next.ofCommand &&
        sameAgentSessionFailureFact(stated.fact, next.fact)
      )
    })
      ? previous
      : facts
  // Written after commit, so render stays pure.
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}
