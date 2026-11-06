// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useNativeChatTurnStatus } from './use-native-chat-turn-status'

describe('useNativeChatTurnStatus', () => {
  it('keeps result identity across status-only renders so transcript slots are not rebuilt', () => {
    const turnKeys = ['turn-1']
    const settledTurns = new Map([['turn-1', { startedAt: 1, workedSeconds: 5 }]])
    const { result, rerender } = renderHook(
      ({ thinking }) =>
        useNativeChatTurnStatus({
          turnKeys,
          liveTurnKey: 'turn-1',
          isWorking: true,
          workingStartedAt: 1,
          settledTurns,
          thinking
        }),
      { initialProps: { thinking: false } }
    )
    const first = result.current
    rerender({ thinking: false })
    expect(result.current).toBe(first)
    rerender({ thinking: true })
    expect(result.current).not.toBe(first)
    expect(result.current.active?.thinking).toBe(true)
  })
})
