import { describe, expect, it } from 'vitest'
import {
  isNativeChatSupportedAgent,
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from './native-chat-agent-support'

describe('resolveNativeChatTranscriptAgent', () => {
  it('maps OpenClaude onto the Claude transcript format', () => {
    expect(resolveNativeChatTranscriptAgent('openclaude')).toBe('claude')
    expect(resolveNativeChatTranscriptAgent('claude')).toBe('claude')
  })

  it('passes codex and grok through and rejects everything else', () => {
    expect(resolveNativeChatTranscriptAgent('codex')).toBe('codex')
    expect(resolveNativeChatTranscriptAgent('grok')).toBe('grok')
    expect(resolveNativeChatTranscriptAgent('cursor')).toBeNull()
    expect(resolveNativeChatTranscriptAgent(null)).toBeNull()
    expect(resolveNativeChatTranscriptAgent(undefined)).toBeNull()
  })
})

describe('isNativeChatSupportedAgent', () => {
  it('recognizes the parseable agents and rejects unknown / nullish input', () => {
    expect(isNativeChatSupportedAgent('claude')).toBe(true)
    expect(isNativeChatSupportedAgent('openclaude')).toBe(true)
    expect(isNativeChatSupportedAgent('cursor')).toBe(false)
    expect(isNativeChatSupportedAgent(null)).toBe(false)
    expect(isNativeChatSupportedAgent(undefined)).toBe(false)
  })
})

describe('shouldStepNativeChatAskAnswer', () => {
  it('steps the digit-commit selector agents (Claude, OpenClaude, Codex)', () => {
    expect(shouldStepNativeChatAskAnswer('claude')).toBe(true)
    expect(shouldStepNativeChatAskAnswer('openclaude')).toBe(true)
    // Codex 0.145's request_user_input card ignores typed labels and commits on
    // the highlighted row, so pasted answers misdeliver like STA-1860.
    expect(shouldStepNativeChatAskAnswer('codex')).toBe(true)
  })

  it('does not step other or unknown agents', () => {
    expect(shouldStepNativeChatAskAnswer('grok')).toBe(false)
    expect(shouldStepNativeChatAskAnswer('cursor')).toBe(false)
    expect(shouldStepNativeChatAskAnswer(null)).toBe(false)
    expect(shouldStepNativeChatAskAnswer(undefined)).toBe(false)
  })
})
