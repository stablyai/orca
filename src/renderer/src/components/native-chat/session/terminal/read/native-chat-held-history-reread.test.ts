import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { spliceHeldHistoryReread } from './native-chat-held-history-reread'

function row(n: number): NativeChatMessage {
  return {
    id: `row-${n}`,
    role: 'user',
    blocks: [{ type: 'text', text: `row-${n}` }],
    timestamp: 1,
    source: 'transcript',
    transcriptOrder: n
  }
}

const rows = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => row(from + i))

describe('spliceHeldHistoryReread', () => {
  it('refuses a re-read overtaken by a page of older rows it did not reach', () => {
    const held = { phase: 'ready' as const, messages: rows(300, 1_000) }
    expect(spliceHeldHistoryReread('claude', rows(500, 1_000), held, row(700))).toBeUndefined()
  })

  it('splices a re-read that reaches the held depth under the newer window', () => {
    const held = { phase: 'ready' as const, messages: rows(300, 1_000) }
    const reread = rows(300, 900).map((message) => ({ ...message, blocks: [] }))
    const spliced = spliceHeldHistoryReread('claude', reread, held, row(700))
    expect(spliced).toHaveLength(700)
    expect(spliced?.[0]).toEqual({ ...row(300), blocks: [] })
    expect(spliced?.[400]).toEqual(row(700))
  })
})
