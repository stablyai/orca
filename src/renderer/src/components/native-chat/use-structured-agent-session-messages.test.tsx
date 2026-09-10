// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'

afterEach(cleanup)
const EMPTY: never[] = []
function tool(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    observedAt: sequence,
    sequence,
    body: { kind: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'running' }
  }
}

it('retains only unchanged item projections across updates, reorder, deletion, and rehydration', () => {
  const first = tool('first', 1)
  const second = tool('second', 2)
  const { result, rerender } = renderHook(
    (items: AgentJournalRenderItem[]) => useStructuredAgentSessionMessages(items, EMPTY, EMPTY),
    { initialProps: [first, second] }
  )
  const initial = result.current
  rerender([first, second])
  expect(result.current[0]).toBe(initial[0])
  expect(result.current[1]).toBe(initial[1])
  const completed: AgentJournalRenderItem = {
    ...second,
    revision: 2,
    body: {
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'pwd' },
      state: 'completed',
      output: { head: '/workspace', truncated: false, byteLength: 10, digest: 'a' }
    }
  }
  for (const items of [
    [first, completed],
    [completed, first],
    [completed],
    [structuredClone(completed)]
  ]) {
    rerender(items)
    expect(result.current).toEqual(projectStructuredAgentSessionMessages(items, EMPTY, EMPTY))
    expect(result.current.find((message) => message.id === 'second')).not.toBe(initial[1])
  }
  const replacement = {
    ...first,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'Another session with the same item id' }]
    }
  }
  rerender([replacement])
  expect(result.current).toEqual(projectStructuredAgentSessionMessages([replacement], EMPTY, EMPTY))
  expect(result.current[0]).not.toBe(initial[0])
})

it('keeps optimistic sends and their settlement identical to uncached projection', () => {
  const entry = createStructuredAgentSessionOutboxEntry({
    clientMessageId: 'send',
    sessionId: 'session',
    text: 'Send this',
    attachments: [],
    queuedAt: 1
  })
  const submission: AgentJournalSubmission = {
    clientMessageId: 'send',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
  const { result, rerender } = renderHook(
    ({
      items,
      submissions
    }: {
      items: AgentJournalRenderItem[]
      submissions: AgentJournalSubmission[]
    }) => useStructuredAgentSessionMessages(items, [entry], submissions),
    { initialProps: { items: [tool('tool', 1)], submissions: [submission] } }
  )
  for (const dispatchState of ['pending', 'unknown', 'accepted'] as const) {
    const props = { items: [tool('tool', 1)], submissions: [{ ...submission, dispatchState }] }
    rerender(props)
    expect(result.current).toEqual(
      projectStructuredAgentSessionMessages(props.items, [entry], props.submissions)
    )
  }
})

it('does no transcript projection work on a status-only render', () => {
  const items = [tool('tool', 1)]
  const { result, rerender } = renderHook(() =>
    useStructuredAgentSessionMessages(items, EMPTY, EMPTY)
  )
  const initial = result.current
  rerender()
  expect(result.current).toBe(initial)
})
