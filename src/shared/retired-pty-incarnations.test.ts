import { describe, expect, it } from 'vitest'
import { pruneRetiredPtyIncarnations } from './retired-pty-incarnations'

describe('retired PTY incarnation retention', () => {
  it('removes expired records before they can accumulate', () => {
    const records = new Map([
      ['expired', { incarnationId: 'a', code: 0, expiresAt: 10 }],
      ['live', { incarnationId: 'b', code: 0, expiresAt: 30 }]
    ])

    pruneRetiredPtyIncarnations(records, 20)

    expect([...records.keys()]).toEqual(['live'])
  })

  it('caps records when many distinct PTYs retire together', () => {
    const records = new Map(
      Array.from({ length: 1001 }, (_, index) => [
        `pty-${index}`,
        { incarnationId: `inc-${index}`, code: 0, expiresAt: 100 }
      ])
    )

    pruneRetiredPtyIncarnations(records, 0)

    expect(records.size).toBe(1000)
    expect(records.has('pty-0')).toBe(false)
    expect(records.has('pty-1000')).toBe(true)
  })
})
