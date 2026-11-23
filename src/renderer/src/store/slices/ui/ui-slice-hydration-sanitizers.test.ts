import { expect, it } from 'vitest'
import { sanitizePaneKeyTimestampRecord } from './ui-slice-hydration-sanitizers'

const LEAF_1 = 'e8bc163c-82ee-4187-a328-8c7d4ac636db'

it('counts a chat mark and its tab-keyed original once, even after only one of them changes', () => {
  const marks: Record<string, number> = {}
  for (let at = 2; at <= 500; at++) {
    marks[`terminal-${at}:pane-${at}`] = at
  }
  marks[`structured-agent-session-s1:${LEAF_1}`] = 600
  marks[`agent-chat-tab-v1-abc:${LEAF_1}`] = 1
  expect(Object.keys(sanitizePaneKeyTimestampRecord(marks))).toHaveLength(501)

  const kept = sanitizePaneKeyTimestampRecord({ ...marks, 'terminal-t:pane-0': 0.5 })
  expect(Object.keys(kept)).toHaveLength(501)
  expect(kept['terminal-t:pane-0']).toBeUndefined()
  expect(kept[`agent-chat-tab-v1-abc:${LEAF_1}`]).toBe(1)
})
