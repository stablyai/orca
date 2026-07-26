import { describe, it, expect } from 'vitest'
import { canToggleNativeChat } from './native-chat-availability'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'

describe('canToggleNativeChat', () => {
  it('allows a terminal launched with a supported coding agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'claude'
      })
    ).toBe(true)
  })

  it('allows a terminal with a live detected supported agent but no launchAgent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        detectedAgent: 'codex'
      })
    ).toBe(true)
  })

  it('allows a terminal with a resolved title/foreground supported agent before hooks arrive', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        resolvedAgent: 'claude'
      })
    ).toBe(true)
  })

  it('allows the OpenClaude variant', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'openclaude'
      })
    ).toBe(true)
  })

  it('allows an existing chat view to toggle back after live signals are gone', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        isChatViewMode: true
      })
    ).toBe(true)
  })

  it('accepts local Grok once native chat can parse its transcript', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(null)
      })
    ).toBe(true)
  })

  it('accepts runtime-owned Grok because Model B reads the transcript locally', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable:
          isNativeChatTranscriptLocalReadable('runtime-ssh-env-1')
      })
    ).toBe(true)
  })

  it('rejects Model-A SSH Grok when its transcript is remote-only', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable('ssh-target-1')
      })
    ).toBe(false)
  })

  it('lets an existing Model-A SSH Grok chat toggle back to terminal', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: false,
        isChatViewMode: true
      })
    ).toBe(true)
  })

  it('rejects an unsupported agent detected live (Gemini)', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        detectedAgent: 'gemini'
      })
    ).toBe(false)
  })

  it('accepts Grok when resolved from the title', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        resolvedAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: true
      })
    ).toBe(true)
  })

  it('rejects a stale supported title when live detection found an unsupported agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
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
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'codex',
        detectedAgent: 'gemini'
      })
    ).toBe(false)
  })

  it('rejects a stale supported title when launch metadata names an unsupported agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'gemini',
        resolvedAgent: 'claude'
      })
    ).toBe(false)
  })

  it('rejects otherwise eligible terminals while the experimental flag is off', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: false,
        contentType: 'terminal',
        launchAgent: 'claude'
      })
    ).toBe(false)
  })

  it('rejects a plain shell terminal with no agent', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: null,
        detectedAgent: null
      })
    ).toBe(false)
  })

  it('rejects a plain shell terminal with everything omitted', () => {
    expect(
      canToggleNativeChat({ experimentalNativeChatEnabled: true, contentType: 'terminal' })
    ).toBe(false)
  })

  it('rejects an editor tab even if a supported agent hint were somehow present', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'editor',
        launchAgent: 'codex',
        detectedAgent: 'codex'
      })
    ).toBe(false)
  })

  it('rejects a browser tab', () => {
    expect(
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'browser',
        detectedAgent: 'claude'
      })
    ).toBe(false)
  })
})
