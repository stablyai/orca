import { describe, expect, it } from 'vitest'
import {
  canMirrorLaunchDraftToNativeChat,
  finalizeAgentTabStartingView
} from './native-chat-starting-view'

const chatDefault = { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }
const terminalDefault = { experimentalNativeChat: true, openAgentTabsInChatByDefault: false }

describe('finalizeAgentTabStartingView', () => {
  it("applies the deciding host's default when no device decided: chat, else nothing", () => {
    expect(finalizeAgentTabStartingView({ settings: chatDefault, agent: 'claude' })).toBe('chat')
    // A terminal default records nothing, so every viewer keeps its own default (Q-A1).
    expect(finalizeAgentTabStartingView({ settings: terminalDefault, agent: 'claude' })).toBe(
      undefined
    )
    expect(finalizeAgentTabStartingView({ settings: null, agent: 'claude' })).toBe(undefined)
  })

  it("applies the launching device's default instead of the host's", () => {
    expect(
      finalizeAgentTabStartingView({
        launcherDefaultView: 'terminal',
        settings: chatDefault,
        agent: 'claude'
      })
    ).toBe(undefined)
    expect(
      finalizeAgentTabStartingView({
        launcherDefaultView: 'chat',
        settings: terminalDefault,
        agent: 'claude'
      })
    ).toBe('chat')
    // The host's own experimental opt-out is a fallback input, not a veto of the launcher.
    expect(
      finalizeAgentTabStartingView({ launcherDefaultView: 'chat', settings: null, agent: 'claude' })
    ).toBe('chat')
  })

  it('keeps a decided view over every default', () => {
    expect(
      finalizeAgentTabStartingView({ viewMode: 'terminal', settings: chatDefault, agent: 'claude' })
    ).toBe('terminal')
    expect(
      finalizeAgentTabStartingView({
        viewMode: 'chat',
        launcherDefaultView: 'terminal',
        settings: terminalDefault,
        agent: 'claude'
      })
    ).toBe('chat')
  })

  it('pins terminal for a draft chat cannot mirror, whatever the default', () => {
    for (const settings of [chatDefault, terminalDefault]) {
      expect(
        finalizeAgentTabStartingView({
          settings,
          agent: 'claude',
          promptDelivery: 'draft',
          launchDraftText: 'a\u2028b'
        })
      ).toBe('terminal')
    }
  })

  it('pins nothing for an empty draft, which hides nothing', () => {
    expect(
      finalizeAgentTabStartingView({
        settings: terminalDefault,
        agent: 'claude',
        promptDelivery: 'draft',
        launchDraftText: '  '
      })
    ).toBe(undefined)
  })

  it('records nothing when a default asks for chat that cannot show the launch', () => {
    expect(
      finalizeAgentTabStartingView({ launcherDefaultView: 'chat', settings: null, agent: 'aider' })
    ).toBe(undefined)
    expect(
      finalizeAgentTabStartingView({
        settings: chatDefault,
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: false
      })
    ).toBe(undefined)
    expect(
      finalizeAgentTabStartingView({
        settings: chatDefault,
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: true
      })
    ).toBe('chat')
    // A decided chat that cannot show starts in terminal.
    expect(finalizeAgentTabStartingView({ viewMode: 'chat', settings: null, agent: 'aider' })).toBe(
      'terminal'
    )
  })

  it('gives a plain shell no starting view', () => {
    expect(finalizeAgentTabStartingView({ viewMode: 'chat', settings: chatDefault })).toBe(
      undefined
    )
  })

  it('is idempotent, so a second host pass with the same inputs never changes the result', () => {
    const cases = [
      { settings: chatDefault, agent: 'codex' },
      { launcherDefaultView: 'terminal' as const, settings: chatDefault, agent: 'codex' },
      {
        settings: terminalDefault,
        agent: 'codex',
        promptDelivery: 'draft' as const,
        launchDraftText: 'a\u2028b'
      }
    ]
    for (const input of cases) {
      const once = finalizeAgentTabStartingView(input)
      expect(finalizeAgentTabStartingView({ ...input, viewMode: once })).toBe(once)
    }
  })
})

describe('canMirrorLaunchDraftToNativeChat (moved, unchanged)', () => {
  it('accepts a CR/LF draft and refuses empty or Unicode line separators', () => {
    expect(canMirrorLaunchDraftToNativeChat('fix\r\nthe bug')).toBe(true)
    expect(canMirrorLaunchDraftToNativeChat('   ')).toBe(false)
    expect(canMirrorLaunchDraftToNativeChat('a\u2029b')).toBe(false)
  })
})
