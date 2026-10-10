import { describe, expect, it } from 'vitest'
import { copyOnWriteRecord } from './copy-on-write-record'

describe('copyOnWriteRecord', () => {
  it('returns the source untouched when nothing is written', () => {
    const source = { a: 1 }
    const record = copyOnWriteRecord(source)
    record.delete('missing')
    expect(record.read()).toBe(source)
    expect(source).toEqual({ a: 1 })
  })

  it('clones once and never mutates the source', () => {
    const source = { a: 1, b: 2 }
    const record = copyOnWriteRecord(source)
    record.set('c', 3)
    const afterFirstWrite = record.read()
    record.delete('a')
    expect(record.read()).toBe(afterFirstWrite)
    expect(record.read()).toEqual({ b: 2, c: 3 })
    expect(source).toEqual({ a: 1, b: 2 })
  })

  it('deletes a key added after the clone', () => {
    const record = copyOnWriteRecord<number>({})
    record.set('a', 1)
    record.delete('a')
    expect(record.read()).toEqual({})
  })
})
