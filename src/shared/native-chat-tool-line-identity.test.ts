import { expect, it } from 'vitest'
import type { NativeChatToolCallBlock } from './native-chat-types'
import { nativeChatToolLineIdentity } from './native-chat-tool-line-identity'

it('uses object identity for anonymous mobile rows without serializing large input', () => {
  const input = {
    toJSON: () => {
      throw new Error('Input must stay unread.')
    }
  }
  const block: NativeChatToolCallBlock = { type: 'tool-call', name: 'Read', input }
  const original = nativeChatToolLineIdentity(block, new Map(), true)
  expect(nativeChatToolLineIdentity(block, new Map(), true)).toBe(original)
  expect(nativeChatToolLineIdentity({ ...block }, new Map(), true)).not.toBe(original)
  const seen = new Map<string, number>()
  expect(nativeChatToolLineIdentity(block, seen, true)).not.toBe(
    nativeChatToolLineIdentity(block, seen, true)
  )
})

it('preserves named desktop identity and independent duplicate occurrences', () => {
  const block: NativeChatToolCallBlock = {
    type: 'tool-call',
    callId: 'id',
    name: 'Read',
    input: {}
  }
  expect(nativeChatToolLineIdentity(block, new Map())).toBe('call:id')
  const seen = new Map<string, number>()
  expect(nativeChatToolLineIdentity(block, seen, true)).toBe('call:id')
  expect(nativeChatToolLineIdentity(block, seen, true)).toBe('call-occurrence:["id",1]')
})
