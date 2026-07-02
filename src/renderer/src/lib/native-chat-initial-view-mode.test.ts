import { describe, it, expect } from 'vitest'
import {
  decideInitialAgentTabViewMode,
  initialAgentTabViewModeProps
} from './native-chat-initial-view-mode'

describe('decideInitialAgentTabViewMode', () => {
  it("returns 'chat' when native chat and the opt-in default setting are on", () => {
    expect(decideInitialAgentTabViewMode('claude', true, true)).toBe('chat')
    expect(decideInitialAgentTabViewMode('codex', true, true)).toBe('chat')
  })

  it('returns undefined for CodeWhale because native chat cannot render it', () => {
    expect(decideInitialAgentTabViewMode('codewhale', true, true)).toBeUndefined()
  })

  it('returns undefined when native chat is disabled', () => {
    expect(decideInitialAgentTabViewMode('claude', false, true)).toBeUndefined()
  })

  it('returns undefined when the default-chat setting is off', () => {
    expect(decideInitialAgentTabViewMode('claude', true, false)).toBeUndefined()
  })

  it('returns undefined when the setting is missing (legacy settings)', () => {
    expect(decideInitialAgentTabViewMode('claude', true, undefined)).toBeUndefined()
  })

  it('returns tab creation props only when chat should be the initial mode', () => {
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true
        },
        'claude'
      )
    ).toEqual({ viewMode: 'chat' })
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: false,
          openAgentTabsInChatByDefault: true
        },
        'claude'
      )
    ).toEqual({})
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true
        },
        'codewhale'
      )
    ).toEqual({})
  })
})
