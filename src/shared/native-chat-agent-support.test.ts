import { describe, expect, it } from 'vitest'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresHostReadableTranscript,
  nativeChatRequiresLocalTranscript,
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from './native-chat-agent-support'

describe('resolveNativeChatTranscriptAgent', () => {
  it('maps OpenClaude onto the Claude transcript format', () => {
    expect(resolveNativeChatTranscriptAgent('openclaude')).toBe('claude')
    expect(resolveNativeChatTranscriptAgent('claude')).toBe('claude')
  })

  it('passes codex, grok, omp and opencode through and rejects everything else', () => {
    expect(resolveNativeChatTranscriptAgent('codex')).toBe('codex')
    expect(resolveNativeChatTranscriptAgent('grok')).toBe('grok')
    expect(resolveNativeChatTranscriptAgent('omp')).toBe('omp')
    expect(resolveNativeChatTranscriptAgent('opencode')).toBe('opencode')
    expect(resolveNativeChatTranscriptAgent('cursor')).toBeNull()
    expect(resolveNativeChatTranscriptAgent(null)).toBeNull()
    expect(resolveNativeChatTranscriptAgent(undefined)).toBeNull()
  })
})

describe('isNativeChatSupportedAgent', () => {
  it('recognizes the parseable agents and rejects unknown / nullish input', () => {
    expect(isNativeChatSupportedAgent('claude')).toBe(true)
    expect(isNativeChatSupportedAgent('openclaude')).toBe(true)
    expect(isNativeChatSupportedAgent('omp')).toBe(true)
    expect(isNativeChatSupportedAgent('opencode')).toBe(true)
    expect(isNativeChatSupportedAgent('cursor')).toBe(false)
    expect(isNativeChatSupportedAgent(null)).toBe(false)
    expect(isNativeChatSupportedAgent(undefined)).toBe(false)
  })
})

describe('nativeChatRequiresLocalTranscript', () => {
  it('covers agents whose hooks disclose no direct transcript path', () => {
    expect(nativeChatRequiresLocalTranscript('grok')).toBe(true)
    expect(nativeChatRequiresLocalTranscript('omp')).toBe(true)
    expect(nativeChatRequiresLocalTranscript('opencode')).toBe(true)
    expect(nativeChatRequiresLocalTranscript('claude')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('openclaude')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('codex')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('cursor')).toBe(false)
    expect(nativeChatRequiresLocalTranscript(null)).toBe(false)
    expect(nativeChatRequiresLocalTranscript(undefined)).toBe(false)
  })
})

describe('nativeChatRequiresHostReadableTranscript', () => {
  it('covers every supported transcript reader', () => {
    // Model-A SSH has no runtime RPC reader, so even a hook-reported path must
    // belong to this process's host; runtime-owned hosts satisfy the same check
    // on their own runtime process.
    expect(nativeChatRequiresHostReadableTranscript('grok')).toBe(true)
    expect(nativeChatRequiresHostReadableTranscript('omp')).toBe(true)
    expect(nativeChatRequiresHostReadableTranscript('opencode')).toBe(true)
    expect(nativeChatRequiresHostReadableTranscript('claude')).toBe(true)
    expect(nativeChatRequiresHostReadableTranscript('openclaude')).toBe(true)
    expect(nativeChatRequiresHostReadableTranscript('codex')).toBe(true)
    expect(nativeChatRequiresHostReadableTranscript('cursor')).toBe(false)
    expect(nativeChatRequiresHostReadableTranscript(null)).toBe(false)
    expect(nativeChatRequiresHostReadableTranscript(undefined)).toBe(false)
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
