import { expect, it } from 'vitest'
import { applyJsonlCursorBytes, planJsonlRead } from './codex-rollout-jsonl-format'

it('preserves multibyte rollout fields across partial and overtaken reads', () => {
  const bytes = Buffer.from('{"name":"\u00e9\u4e2d\u{1f600}"}\n')
  for (let split = 1; split < bytes.length; split++) {
    const cursor = { filePath: 'rollout.jsonl', offset: 0, carry: '' }
    const early = { ...planJsonlRead(cursor, split), bytes: bytes.subarray(0, split) }
    const late = { ...planJsonlRead(cursor, bytes.length), bytes }
    expect(applyJsonlCursorBytes(cursor, early)).toEqual([])
    const nextPoll = {
      ...planJsonlRead(cursor, bytes.length),
      bytes: bytes.subarray(cursor.offset)
    }
    expect(applyJsonlCursorBytes({ ...cursor }, nextPoll)).toEqual([
      { name: '\u00e9\u4e2d\u{1f600}' }
    ])
    expect(applyJsonlCursorBytes(cursor, late)).toEqual([{ name: '\u00e9\u4e2d\u{1f600}' }])
    expect(cursor.offset).toBe(bytes.length)
    expect(cursor.carry).toBe('')
    expect(applyJsonlCursorBytes(cursor, early)).toEqual([])
  }
})
