import { describe, it, expect } from 'vitest'
import { canToggleNativeChat } from './native-chat-availability'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'

describe('canToggleNativeChat', () => {
  // omp exposes no hook transcript path; its session file requires readable agent storage.
  it('rejects Model-A SSH omp but accepts it local and runtime-owned', () => {
    const forConnection = (connectionId: string | null): boolean =>
      canToggleNativeChat({
        contentType: 'terminal',
        launchAgent: 'omp',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
      })
    expect(forConnection('ssh-target-1')).toBe(false)
    expect(forConnection(null)).toBe(true)
    expect(forConnection('runtime-ssh-env-1')).toBe(true)
  })

  it('lets an existing Model-A SSH Grok chat toggle back to terminal', () => {
    expect(
      canToggleNativeChat({
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: false,
        isChatViewMode: true
      })
    ).toBe(true)
  })

  it('rejects a stale supported title when live detection found an unsupported agent', () => {
    expect(
      canToggleNativeChat({
        contentType: 'terminal',
        launchAgent: null,
        detectedAgent: 'gemini',
        resolvedAgent: 'codex'
      })
    ).toBe(false)
  })

  it('rejects stale launch metadata when live detection found an unsupported agent', () => {
    expect(
      canToggleNativeChat({
        contentType: 'terminal',
        launchAgent: 'codex',
        detectedAgent: 'gemini'
      })
    ).toBe(false)
  })

  it('rejects a stale supported title when launch metadata names an unsupported agent', () => {
    expect(
      canToggleNativeChat({
        contentType: 'terminal',
        launchAgent: 'gemini',
        resolvedAgent: 'claude'
      })
    ).toBe(false)
  })
})
