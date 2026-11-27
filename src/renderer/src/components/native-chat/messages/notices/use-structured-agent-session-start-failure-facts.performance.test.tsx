// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { noteStreamedTextRevision } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

afterEach(cleanup)

let bodyReads = 0

/** A saved reply row whose body counts each read, so a scan over history shows in the count. */
function counted(sequence: number, text: string): AgentJournalRenderItem {
  const body = { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] } as const
  const row = { itemId: `reply-${sequence}`, revision: 1, sequence, observedAt: 1 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the getter defines `body`, completing the row.
  return Object.defineProperty(row, 'body', {
    enumerable: true,
    get: () => {
      bodyReads += 1
      return body
    }
  }) as AgentJournalRenderItem
}

/** Rows the start-failure scan visits over 20 text-only windows into the last reply. */
function rowsVisitedStreaming(rows: number): number {
  const saved: readonly AgentJournalRenderItem[] = Array.from({ length: rows }, (_, index) =>
    counted(index + 1, `Row ${index}`)
  )
  const { rerender } = renderHook(
    ({ items }) => useStructuredAgentSessionStartFailureFacts(items, true),
    { initialProps: { items: saved } }
  )
  let items: readonly AgentJournalRenderItem[] = saved
  let text = `Row ${rows - 1}`
  bodyReads = 0
  for (let window = 0; window < 20; window++) {
    text += ' more'
    const next = [...items.slice(0, -1), counted(rows, text)]
    noteStreamedTextRevision(next, items)
    items = next
    rerender({ items })
  }
  const visited = bodyReads
  // A new row is structure: the scan runs again.
  rerender({ items: [...items, counted(rows + 1, 'Next')] })
  expect(bodyReads).toBeGreaterThan(visited)
  return visited
}

// Perf contract: start failures are status rows, so while only a reply's text streams the scan
// keeps its result and visits no rows, at any history length.
it('visits no rows while only a reply streams, at N and 10N rows', () => {
  expect(rowsVisitedStreaming(2_000)).toBe(0)
  expect(rowsVisitedStreaming(20_000)).toBe(0)
})
