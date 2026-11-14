// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatSideChat } from './use-native-chat-side-chat'
import type { NativeChatForkSurface } from './use-native-chat-fork'

function forkThrough(ids: string[], pendingItemId: string | null = null): NativeChatForkSurface {
  const rowAction = {
    support: { kind: 'known', fork: 'checkpoint' },
    pendingItemId,
    request: vi.fn()
  } as const
  return { ...rowAction, contextFloorSequence: 0, forkableItemIds: new Set(ids), rowAction }
}

it('refuses a response a rewind dropped before the transcript reported it', async () => {
  const { result, rerender } = renderHook(({ fork }) => useNativeChatSideChat(fork), {
    initialProps: { fork: forkThrough(['reply-1']) }
  })
  act(() => result.current?.reportForkPoint({ kind: 'ready', throughItemId: 'reply-1' }))
  rerender({ fork: forkThrough([]) })

  const outcome = await result.current?.open('why?')

  expect(outcome).toHaveProperty('refused')
})

it('refuses while another fork from the chat is still opening', async () => {
  const fork = forkThrough(['reply-1'], 'reply-1')
  const { result } = renderHook(() => useNativeChatSideChat(fork))
  act(() => result.current?.reportForkPoint({ kind: 'ready', throughItemId: 'reply-1' }))

  const outcome = await result.current?.open('why?')

  expect(outcome).toHaveProperty('refused')
  expect(result.current?.notReadyReason).not.toBeNull()
  expect(fork.request).not.toHaveBeenCalled()
})
