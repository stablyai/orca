import { describe, expect, it } from 'vitest'
import { shouldStepNativeChatAskAnswer } from './use-native-chat-interactive-send'

describe('shouldStepNativeChatAskAnswer', () => {
  it('uses Claude multi-question stepping for OpenClaude', () => {
    expect(shouldStepNativeChatAskAnswer('openclaude')).toBe(true)
    expect(shouldStepNativeChatAskAnswer('claude')).toBe(true)
    expect(shouldStepNativeChatAskAnswer('codex')).toBe(false)
  })
})
