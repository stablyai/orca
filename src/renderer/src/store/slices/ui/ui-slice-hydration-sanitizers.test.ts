import { expect, it } from 'vitest'
import { sanitizePaneKeyTimestampRecord } from './ui-slice-hydration-sanitizers'

const LEAF_1 = 'e8bc163c-82ee-4187-a328-8c7d4ac636db'

it('counts same-leaf marks with different values separately', () => {
  const marks: Record<string, number> = {}
  for (let at = 2; at <= 500; at++) {
    marks[`terminal-${at}:pane-${at}`] = at
  }
  marks[`structured-agent-session-s1:${LEAF_1}`] = 600
  marks[`agent-chat-tab-v1-abc:${LEAF_1}`] = 1
  const kept = sanitizePaneKeyTimestampRecord(marks)
  expect(Object.keys(kept)).toHaveLength(500)
  expect(kept[`structured-agent-session-s1:${LEAF_1}`]).toBe(600)
  expect(kept[`agent-chat-tab-v1-abc:${LEAF_1}`]).toBeUndefined()
})

it('keeps every key that shares a retained leaf-and-value pair', () => {
  const marks: Record<string, number> = {}
  for (let at = 2; at <= 501; at++) {
    marks[`terminal-${at}:pane-${at}`] = at
  }
  marks[`structured-agent-session-s1:${LEAF_1}`] = 600
  marks[`agent-chat-tab-v1-abc:${LEAF_1}`] = 600

  const kept = sanitizePaneKeyTimestampRecord(marks)
  expect(Object.keys(kept)).toHaveLength(501)
  expect(kept['terminal-2:pane-2']).toBeUndefined()
  expect(kept[`structured-agent-session-s1:${LEAF_1}`]).toBe(600)
  expect(kept[`agent-chat-tab-v1-abc:${LEAF_1}`]).toBe(600)
})
