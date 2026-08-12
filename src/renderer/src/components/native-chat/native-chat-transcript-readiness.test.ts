import { describe, expect, it } from 'vitest'
import { isNativeChatInteractiveTranscriptSettled } from './native-chat-transcript-readiness'

describe('isNativeChatInteractiveTranscriptSettled', () => {
  it('accepts a ready transcript', () => {
    expect(isNativeChatInteractiveTranscriptSettled('ready', 0)).toBe(true)
  })

  it('accepts retained rows when the refresh fails', () => {
    expect(isNativeChatInteractiveTranscriptSettled('error', 1)).toBe(true)
  })

  it('rejects loading and empty error states', () => {
    expect(isNativeChatInteractiveTranscriptSettled('loading', 3)).toBe(false)
    expect(isNativeChatInteractiveTranscriptSettled('error', 0)).toBe(false)
  })
})
