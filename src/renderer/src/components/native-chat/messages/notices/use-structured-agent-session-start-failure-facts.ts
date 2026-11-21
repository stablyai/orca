import { useEffect, useMemo, useRef } from 'react'
import type { AgentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import {
  sameAgentSessionFailureFact,
  agentSessionVisibleFailureFacts
} from '../../../../../../shared/agent-session/failures/agent-session-visible-failures'

const NO_FACTS: readonly AgentSessionFailureFact[] = []

/** Read start failures only while enabled; retain unchanged facts so streaming cannot rebuild delivery notices. */
export function useStructuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[],
  enabled: boolean
): readonly AgentSessionFailureFact[] {
  const facts = useMemo(
    () => (enabled ? agentSessionVisibleFailureFacts(items) : NO_FACTS),
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

/** A chat's start failures, read while a returned card or a refused send can name one, and always for Claude. */
export function useStructuredChatStartFailureFacts(
  session: {
    journalItems: readonly AgentJournalRenderItem[]
    submissions: readonly Pick<AgentJournalSubmission, 'dispatchState' | 'reason' | 'rejection'>[]
  },
  queue: { cards: readonly { state: string }[] },
  agent: string
): readonly AgentSessionFailureFact[] {
  const needed =
    queue.cards.some((card) => card.state === 'returned') ||
    session.submissions.some(
      (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
    )
  return useStructuredAgentSessionStartFailureFacts(
    session.journalItems,
    needed || agent === 'claude'
  )
}
