import { describe, expect, it } from 'vitest'
import { resolveInitialNativeChatSessionOptions } from './native-chat-launch-session-options'

const settings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  nativeChatSessionOptions: {
    codex: {
      model: 'gpt-5.2-codex',
      valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
    }
  }
}

describe('resolveInitialNativeChatSessionOptions', () => {
  it('omits native-chat preferences from terminal-default launches', () => {
    expect(
      resolveInitialNativeChatSessionOptions(
        { ...settings, openAgentTabsInChatByDefault: false },
        { agent: 'codex' }
      )
    ).toBeUndefined()
  })

  it('applies native-chat preferences when the launch resolves to chat', () => {
    expect(resolveInitialNativeChatSessionOptions(settings, { agent: 'codex' })).toEqual({
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
  })

  it('omits preferences when a draft forces the initial view back to terminal', () => {
    expect(
      resolveInitialNativeChatSessionOptions(settings, {
        agent: 'codex',
        promptDelivery: 'draft',
        launchDraftText: 'one\u2028two'
      })
    ).toBeUndefined()
  })

  it('omits preferences when a remote transcript forces the initial view to terminal', () => {
    const grokSettings = {
      ...settings,
      nativeChatSessionOptions: { grok: { model: 'grok-4.5' } }
    }
    expect(
      resolveInitialNativeChatSessionOptions(grokSettings, {
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: false
      })
    ).toBeUndefined()
  })
})
