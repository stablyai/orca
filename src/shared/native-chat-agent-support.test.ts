import { describe, expect, it } from 'vitest'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript,
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from './native-chat-agent-support'

const UUID = '11111111-1111-4111-8111-111111111111'
const CUSTOM_CLAUDE_ID = `custom-agent:claude:${UUID}`
const CUSTOM_GEMINI_ID = `custom-agent:gemini:${UUID}`

describe('resolveNativeChatTranscriptAgent', () => {
  it('maps OpenClaude onto the Claude transcript format', () => {
    expect(resolveNativeChatTranscriptAgent('openclaude')).toBe('claude')
    expect(resolveNativeChatTranscriptAgent('claude')).toBe('claude')
  })

  it('passes codex, grok and omp through and rejects everything else', () => {
    expect(resolveNativeChatTranscriptAgent('codex')).toBe('codex')
    expect(resolveNativeChatTranscriptAgent('grok')).toBe('grok')
    expect(resolveNativeChatTranscriptAgent('omp')).toBe('omp')
    expect(resolveNativeChatTranscriptAgent('cursor')).toBeNull()
    expect(resolveNativeChatTranscriptAgent(null)).toBeNull()
    expect(resolveNativeChatTranscriptAgent(undefined)).toBeNull()
  })

  // This registry is keyed by BUILT-IN id on purpose: callers resolve a custom
  // agent to its base first (`resolveNativeChatBaseAgent`), so a raw custom id
  // reaching here means the catalog could not prove a base — fail closed.
  it('rejects a raw custom agent id', () => {
    expect(resolveNativeChatTranscriptAgent(CUSTOM_CLAUDE_ID)).toBeNull()
    expect(resolveNativeChatTranscriptAgent(CUSTOM_GEMINI_ID)).toBeNull()
  })
})

describe('isNativeChatSupportedAgent', () => {
  it('recognizes the parseable agents and rejects unknown / nullish input', () => {
    expect(isNativeChatSupportedAgent('claude')).toBe(true)
    expect(isNativeChatSupportedAgent('openclaude')).toBe(true)
    expect(isNativeChatSupportedAgent('omp')).toBe(true)
    expect(isNativeChatSupportedAgent('cursor')).toBe(false)
    expect(isNativeChatSupportedAgent(null)).toBe(false)
    expect(isNativeChatSupportedAgent(undefined)).toBe(false)
  })

  it('rejects a raw custom agent id, base-supported or not', () => {
    expect(isNativeChatSupportedAgent(CUSTOM_CLAUDE_ID)).toBe(false)
    expect(isNativeChatSupportedAgent(CUSTOM_GEMINI_ID)).toBe(false)
  })
})

describe('nativeChatRequiresLocalTranscript', () => {
  it('covers the agents whose hook discloses no transcript path', () => {
    // Claude/Codex report `transcript_path`; Grok and omp report only an id, so
    // native chat has to find their file on a disk this process can read.
    expect(nativeChatRequiresLocalTranscript('grok')).toBe(true)
    expect(nativeChatRequiresLocalTranscript('omp')).toBe(true)
    expect(nativeChatRequiresLocalTranscript('claude')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('openclaude')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('codex')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('cursor')).toBe(false)
    expect(nativeChatRequiresLocalTranscript(null)).toBe(false)
    expect(nativeChatRequiresLocalTranscript(undefined)).toBe(false)
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
    expect(shouldStepNativeChatAskAnswer('omp')).toBe(false)
    expect(shouldStepNativeChatAskAnswer('cursor')).toBe(false)
    expect(shouldStepNativeChatAskAnswer(null)).toBe(false)
    expect(shouldStepNativeChatAskAnswer(undefined)).toBe(false)
  })
})
