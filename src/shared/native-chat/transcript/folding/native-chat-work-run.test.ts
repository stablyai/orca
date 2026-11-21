import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { nativeChatWorkRunEntries } from './native-chat-work-run'

function call(id: string, callId: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: null,
    blocks: [
      { type: 'tool-call', name: 'shell', callId, input: { command: 'ls' }, state: 'completed' }
    ]
  }
}

it('keys each block of a run by its call, across regrouped messages', () => {
  const { sourceKeys } = nativeChatWorkRunEntries([call('m1', 'a'), call('m2', 'b')])
  expect([...sourceKeys.values()]).toEqual(['call:a', 'call:b'])
})

it('gives every repeat of one call id its own key, past a real key its suffix would reuse', () => {
  const members = [
    call('m0', 'a~1'),
    ...Array.from({ length: 300 }, (_, index) => call(`m${index + 1}`, 'a'))
  ]
  const keys = [...nativeChatWorkRunEntries(members).sourceKeys.values()]

  expect(new Set(keys).size).toBe(members.length)
  expect(keys.slice(0, 3)).toEqual(['call:a~1', 'call:a', 'call:a~2'])
})
