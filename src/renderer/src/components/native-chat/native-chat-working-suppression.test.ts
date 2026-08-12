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
        working: true,
        interrupted: true
      })
    ).toBe(false)
  })

  it('shows working before an interrupt', () => {
    expect(
      shouldShowNativeChatWorking({
        isConversation: true,
        working: true,
        interrupted: false
      })
    ).toBe(true)
  })

  it('clears suppression after reconciled working clears', () => {
    expect(shouldClearNativeChatWorkingSuppression({ working: true })).toBe(false)
    expect(shouldClearNativeChatWorkingSuppression({ working: false })).toBe(true)
  })

  it('clears suppression when a newer working epoch starts while interrupted', () => {
    expect(
      shouldClearNativeChatWorkingSuppression({
        working: true,
        interrupted: true,
        workingEpoch: 20,
        previousWorkingEpoch: 10
      })
    ).toBe(true)
    expect(
      shouldClearNativeChatWorkingSuppression({
        working: true,
        interrupted: true,
        workingEpoch: 10,
        previousWorkingEpoch: 10
      })
    ).toBe(false)
  })
})
