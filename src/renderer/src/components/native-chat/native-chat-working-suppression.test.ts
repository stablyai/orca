import { describe, expect, it } from 'vitest'
import {
  shouldClearNativeChatWorkingSuppression,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'

describe('native chat working suppression', () => {
  it('hides stale working state after a user interrupt', () => {
    expect(
      shouldShowNativeChatWorking({
        isConversation: true,
        viewWorking: true,
        hookWorking: true,
        interrupted: true
      })
    ).toBe(false)
  })

  it('shows working before an interrupt', () => {
    expect(
      shouldShowNativeChatWorking({
        isConversation: true,
        viewWorking: false,
        hookWorking: true,
        interrupted: false
      })
    ).toBe(true)
  })

  it('clears suppression only after all working signals clear', () => {
    expect(shouldClearNativeChatWorkingSuppression({ viewWorking: true, hookWorking: false })).toBe(
      false
    )
    expect(
      shouldClearNativeChatWorkingSuppression({ viewWorking: false, hookWorking: false })
    ).toBe(true)
  })
})
