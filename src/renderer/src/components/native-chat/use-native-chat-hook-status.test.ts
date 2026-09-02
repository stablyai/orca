import { describe, expect, it } from 'vitest'
import { resolveNativeChatHookState } from './use-native-chat-hook-status'

describe('resolveNativeChatHookState', () => {
  const now = 1_000_000

  it('does not treat a restored working row as live activity', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now,
          restoredUnconfirmed: true
        },
        now
      )
    ).toBeNull()
  })

  it('keeps confirmed working activity live', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBe('working')
  })

  it('continues to suppress monitoring rows', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: 'monitoring',
          updatedAt: now,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBeNull()
  })

  it('does not keep an expired working row live', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now - 30 * 60 * 1000 - 1,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBeNull()
  })
})
