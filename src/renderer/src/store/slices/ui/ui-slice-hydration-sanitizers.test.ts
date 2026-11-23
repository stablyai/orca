import { expect, it } from 'vitest'
import { sanitizePaneKeyTimestampRecord } from './ui-slice-hydration-sanitizers'

const LEAF_1 = 'e8bc163c-82ee-4187-a328-8c7d4ac636db'

it('keeps a mark record within 500 keys by dropping a copied chat mark’s tab-keyed original first', () => {
  const marks: Record<string, number> = {}
  for (let at = 2; at <= 500; at++) {
    marks[`terminal-${at}:pane-${at}`] = at
  }
  marks[`structured-agent-session-s1:${LEAF_1}`] = 600
  // Newest of all, yet redundant: an older build's newest-500 cut would drop terminal-2 instead.
  marks[`agent-chat-tab-v1-abc:${LEAF_1}`] = 700

  const kept = sanitizePaneKeyTimestampRecord(marks)
  expect(Object.keys(kept)).toHaveLength(500)
  expect(kept[`agent-chat-tab-v1-abc:${LEAF_1}`]).toBeUndefined()
  expect(kept['terminal-2:pane-2']).toBe(2)
  expect(kept[`structured-agent-session-s1:${LEAF_1}`]).toBe(600)
})
