import { describe, expect, it } from 'vitest'
import { canStopNativeChatAgent } from './native-chat-action-availability'

describe('canStopNativeChatAgent', () => {
  it('requires both a writable target and a stop command', () => {
    expect(canStopNativeChatAgent({ targetWritable: true, stopCommandAvailable: true })).toBe(true)
    expect(canStopNativeChatAgent({ targetWritable: false, stopCommandAvailable: true })).toBe(
      false
    )
    expect(canStopNativeChatAgent({ targetWritable: true, stopCommandAvailable: false })).toBe(
      false
    )
  })
})
