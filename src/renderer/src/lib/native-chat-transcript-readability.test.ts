import { describe, expect, it } from 'vitest'
import { isNativeChatTranscriptLocalReadable } from './native-chat-transcript-readability'

describe('native chat transcript readability', () => {
  it('allows local and runtime-owned hosts but rejects Model-A SSH and unresolved hosts', () => {
    expect(isNativeChatTranscriptLocalReadable(null)).toBe(true)
    expect(isNativeChatTranscriptLocalReadable('runtime-ssh-env-1')).toBe(true)
    expect(isNativeChatTranscriptLocalReadable('ssh-target-1')).toBe(false)
    expect(isNativeChatTranscriptLocalReadable(undefined)).toBe(false)
  })
})
