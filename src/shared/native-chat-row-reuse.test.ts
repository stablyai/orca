import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { normalizeImageTranscriptMessages } from './native-chat-image-transcript-markers'
import { createNativeChatMessageReuse, createNativeChatRowReuse } from './native-chat-row-reuse'

function user(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

describe('createNativeChatMessageReuse', () => {
  const imageTurn = [
    user('source', '[Image: source: /tmp/a.png]'),
    user('prompt', '[Image #1] look')
  ]

  it('keeps an image turn whose blocks are rebuilt with the same values', () => {
    const reuse = createNativeChatMessageReuse()
    const before = reuse(normalizeImageTranscriptMessages([...imageTurn, user('live', 'Hel')]))
    const rebuilt = normalizeImageTranscriptMessages([...imageTurn, user('live', 'Hello')])
    expect(rebuilt[0]?.blocks[0]).not.toBe(before[0]?.blocks[0])

    const after = reuse(rebuilt)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[1]?.blocks).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('hands back the previous array when no row changed', () => {
    const reuse = createNativeChatMessageReuse()
    const before = reuse(normalizeImageTranscriptMessages(imageTurn))

    expect(reuse(normalizeImageTranscriptMessages(imageTurn))).toBe(before)
  })
})

describe('createNativeChatRowReuse', () => {
  it('keeps a row whose nested status is rebuilt equal, and replaces one that changed', () => {
    const reuse = createNativeChatRowReuse<{ status: { seconds: number } | null }>(1)
    const ids = ['a', 'b']
    const before = reuse([{ status: { seconds: 4 } }, { status: null }], (index) => ids[index]!)
    const after = reuse(
      [{ status: { seconds: 4 } }, { status: { seconds: 1 } }],
      (index) => ids[index]!
    )

    expect(after[0]).toBe(before[0])
    expect(after[1]).toEqual({ status: { seconds: 1 } })
  })
})
