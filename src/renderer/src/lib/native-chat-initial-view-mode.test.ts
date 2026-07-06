import { describe, it, expect } from 'vitest'
import {
  decideInitialAgentTabViewMode,
  initialAgentTabViewModeProps
} from './native-chat-initial-view-mode'

describe('decideInitialAgentTabViewMode', () => {
  it("returns 'chat' when native chat and the opt-in default setting are on", () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'codex'
      })
    ).toBe('chat')
  })

  it('returns undefined when native chat is disabled', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: true,
        agent: 'codex'
      })
    ).toBeUndefined()
  })

  it('returns undefined when the default-chat setting is off', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: false,
        agent: 'codex'
      })
    ).toBeUndefined()
  })

  it('returns undefined when the setting is missing (legacy settings)', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: undefined,
        agent: 'codex'
      })
    ).toBeUndefined()
  })

  it('returns undefined for unsupported agents', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'grok'
      })
    ).toBeUndefined()
  })

  it('returns undefined for draft delivery', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'claude',
        promptDelivery: 'draft'
      })
    ).toBeUndefined()
  })

  it('returns tab creation props only when chat should be the initial mode', () => {
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true
        },
        { agent: 'claude' }
      )
    ).toEqual({ viewMode: 'chat' })
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: false,
          openAgentTabsInChatByDefault: true
        },
        { agent: 'claude' }
      )
    ).toEqual({})
  })
})
