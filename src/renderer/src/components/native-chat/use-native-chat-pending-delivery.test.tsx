// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearPendingSendCacheForTests } from './native-chat-pending'
import { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'

describe('useNativeChatPendingDelivery', () => {
  beforeEach(() => clearPendingSendCacheForTests())

  it('arms exact acknowledgement recovery only for text-only sends', () => {
    const messages = []
    const promptSubmissions = []
    const restoreMessage = (): void => {}
    const setWorkingInterrupted = (): void => {}
    const { result } = renderHook(() =>
      useNativeChatPendingDelivery({
        paneKey: 'tab:leaf',
        agent: 'claude',
        messages,
        promptSubmissions,
        restoreMessage,
        setWorkingInterrupted
      })
    )

    act(() => {
      result.current.onOptimisticSend('text only')
      result.current.onOptimisticSend('with image', ['/tmp/image.png'])
      result.current.onOptimisticSend('', ['/tmp/image-only.png'])
    })

    expect(result.current.pending.map((entry) => entry.deliveryCheck !== undefined)).toEqual([
      true,
      false,
      false
    ])
  })
})
