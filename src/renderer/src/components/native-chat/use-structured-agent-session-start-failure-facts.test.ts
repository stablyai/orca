// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

function startFailureRow(startKey: string, fact: AgentSessionFailureFact): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(startKey)),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
    }
  }
}

// A streaming turn hands over a new item list on every delta; the facts must not follow it.
it('holds the same facts while the start rows state nothing new', () => {
  const row = startFailureRow('gen-1', { kind: 'providerStartFailed' })
  const { result, rerender } = renderHook(
    ({ items }) => useStructuredAgentSessionStartFailureFacts(items, true),
    { initialProps: { items: [row] } }
  )
  const first = result.current
  expect(first).toEqual([{ kind: 'providerStartFailed' }])

  rerender({ items: [row, startFailureRow('other-start', { kind: 'providerStartFailed' })] })
  expect(result.current).not.toBe(first)
  const second = result.current

  rerender({ items: [row, startFailureRow('other-start', { kind: 'providerStartFailed' })] })
  expect(result.current).toBe(second)
})
