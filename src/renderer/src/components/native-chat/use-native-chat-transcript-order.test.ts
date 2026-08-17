// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TranscriptOrderModule from './native-chat-transcript-order'
import { useNativeChatTranscriptOrder } from './use-native-chat-transcript-order'

const createOrderSpy = vi.hoisted(() => vi.fn())

vi.mock('./native-chat-transcript-order', async (importOriginal) => {
  const actual = await importOriginal<typeof TranscriptOrderModule>()
  return {
    ...actual,
    createNativeChatTranscriptOrder: (
      ...args: Parameters<typeof actual.createNativeChatTranscriptOrder>
    ) => {
      createOrderSpy()
      return actual.createNativeChatTranscriptOrder(...args)
    }
  }
})

describe('useNativeChatTranscriptOrder', () => {
  beforeEach(() => createOrderSpy.mockClear())

  it('keeps order and updater identity stable across parent re-renders', () => {
    const { result, rerender } = renderHook(() => useNativeChatTranscriptOrder())
    const [firstOrder, firstReplace, firstAppend, firstSettle] = result.current
    const firstMap = firstOrder.messageSequenceById

    rerender()
    rerender()
    rerender()
    expect(createOrderSpy).toHaveBeenCalledTimes(1)

    const [secondOrder, secondReplace, secondAppend, secondSettle] = result.current
    // Same holder: no fresh createNativeChatTranscriptOrder (order+Map) on re-render.
    expect(secondOrder).toBe(firstOrder)
    expect(secondOrder.messageSequenceById).toBe(firstMap)
    expect(secondReplace).toBe(firstReplace)
    expect(secondAppend).toBe(firstAppend)
    expect(secondSettle).toBe(firstSettle)

    act(() => {
      firstReplace()
    })
    expect(result.current[0]).not.toBe(firstOrder)
    expect(result.current[0].generation).toBe(firstOrder.generation + 1)
    expect(result.current[1]).toBe(firstReplace)
  })
})
