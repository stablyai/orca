// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useNativeChatRecallPosition } from './use-native-chat-composer-recall'

describe('useNativeChatRecallPosition', () => {
  it('ends recall once the composer stops holding the recalled prompt', () => {
    const { result, rerender } = renderHook(({ draft }) => useNativeChatRecallPosition(draft), {
      initialProps: { draft: '' }
    })
    const recalled = { id: 'sent-1', recalled: 'fix it' }

    // The position can commit a render ahead of its draft; that is not a mismatch.
    act(() => result.current[1](recalled))
    expect(result.current[0]).toBe(recalled)
    rerender({ draft: 'fix it' })
    expect(result.current[0]).toBe(recalled)

    // Sent: the composer empties, so the same text arriving later is not a recall.
    rerender({ draft: '' })
    expect(result.current[0]).toBeNull()
    rerender({ draft: 'fix it' })
    expect(result.current[0]).toBeNull()
  })
})
