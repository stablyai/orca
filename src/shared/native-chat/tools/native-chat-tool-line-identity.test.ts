import { expect, it } from 'vitest'
import type { NativeChatToolCallBlock, NativeChatToolResultBlock } from '../../native-chat-types'
import { nativeChatToolLineIdentity } from './native-chat-tool-line-identity'

it('keys an anonymous mobile row by a bounded summary, so a refetched copy keeps it', () => {
  const input = {
    command: 'ls',
    a: 1,
    b: 2,
    c: 3,
    d: 4,
    e: 5,
    f: 6,
    g: 7,
    get unread() {
      throw new Error('Input beyond the preview budget must stay unread.')
    }
  }
  const block: NativeChatToolCallBlock = { type: 'tool-call', name: 'Bash', input }
  const original = nativeChatToolLineIdentity(block, new Map(), true)
  expect(original).toBe(
    'tool-call:Bash:{"command":"ls","a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"…":"…"}:0'
  )
  expect(nativeChatToolLineIdentity({ ...block }, new Map(), true)).toBe(original)
  const seen = new Map<string, number>()
  expect(nativeChatToolLineIdentity(block, seen, true)).not.toBe(
    nativeChatToolLineIdentity(block, seen, true)
  )
})

it('keeps a named mobile result through an output update', () => {
  const result: NativeChatToolResultBlock = { type: 'tool-result', callId: 'gone', output: 'a' }
  expect(nativeChatToolLineIdentity({ ...result, output: 'a\nb' }, new Map(), true)).toBe(
    nativeChatToolLineIdentity(result, new Map(), true)
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
