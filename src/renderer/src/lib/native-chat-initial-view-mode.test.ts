import { describe, it, expect } from 'vitest'
import {
  decideInitialAgentTabViewMode,
  initialAgentTabViewModeProps
} from './native-chat-initial-view-mode'

describe('decideInitialAgentTabViewMode', () => {
  it("returns 'chat' when native chat and the opt-in default setting are on", () => {
    expect(decideInitialAgentTabViewMode(true, true)).toBe('chat')
  })

  it('returns undefined when native chat is disabled', () => {
    expect(decideInitialAgentTabViewMode(false, true)).toBeUndefined()
  })

  it('returns undefined when the default-chat setting is off', () => {
    expect(decideInitialAgentTabViewMode(true, false)).toBeUndefined()
  })

  it('returns undefined when the setting is missing (legacy settings)', () => {
    expect(decideInitialAgentTabViewMode(true, undefined)).toBeUndefined()
  })

  it('returns tab creation props only when chat should be the initial mode', () => {
    expect(
      initialAgentTabViewModeProps({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true
      })
    ).toEqual({ viewMode: 'chat' })
    expect(
      initialAgentTabViewModeProps({
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: true
      })
    ).toEqual({})
  })
})
