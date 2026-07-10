import { describe, expect, it } from 'vitest'
import {
  nativeChatHookTurnCompletedByTranscript,
  shouldClearNativeChatWorkingSuppression,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

function message(
  id: string,
  role: NativeChatMessage['role'],
  timestamp: number | null
): NativeChatMessage {
  return {
    id,
    role,
    timestamp,
    source: 'transcript',
    blocks: [{ type: 'text', text: id }]
  }
}

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

  it('hides a stale hook after the matching transcript turn completes', () => {
    expect(
      nativeChatHookTurnCompletedByTranscript(
        [message('user', 'user', 99_900), message('reply', 'assistant', 100_100)],
        100_000
      )
    ).toBe(true)
    expect(
      shouldShowNativeChatWorking({
        isConversation: true,
        viewWorking: false,
        hookWorking: true,
        hookTurnCompletedByTranscript: true,
        interrupted: false
      })
    ).toBe(false)
  })

  it('keeps working while the new transcript turn has no assistant reply', () => {
    expect(
      nativeChatHookTurnCompletedByTranscript(
        [
          message('old-user', 'user', 80),
          message('old-reply', 'assistant', 90),
          message('new-user', 'user', 110)
        ],
        100
      )
    ).toBe(false)
  })

  it('ignores old and timestamp-less transcript messages', () => {
    expect(
      nativeChatHookTurnCompletedByTranscript(
        [
          message('old-user', 'user', 80),
          message('old-reply', 'assistant', 90),
          message('unknown-reply', 'assistant', null)
        ],
        100
      )
    ).toBe(false)
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
