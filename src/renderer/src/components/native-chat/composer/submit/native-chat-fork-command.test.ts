// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatSideChat } from '../../messages/actions/use-native-chat-side-chat'
import type { NativeChatPaneFork } from '../../messages/actions/use-native-chat-fork'
import type { NativeChatSideChatForkPoint } from '../../messages/actions/native-chat-side-chat-fork-point'
import { nativeChatForkCommand } from './use-native-chat-structured-composer-transport'

function paneFork(ids: string[]): NativeChatPaneFork {
  const rowAction = {
    support: { kind: 'known', fork: 'checkpoint' },
    pendingItemId: null,
    request: vi.fn()
  } as const
  return {
    ...rowAction,
    contextFloorSequence: 0,
    forkableItemIds: new Set(ids),
    rowAction,
    forkLatest: vi.fn(() => 'started' as const)
  }
}

function runForkWhileReplying(fork: NativeChatPaneFork, point: NativeChatSideChatForkPoint) {
  const { result } = renderHook(() => useNativeChatSideChat(fork))
  act(() => result.current?.reportForkPoint(point))
  return nativeChatForkCommand({ fork, sideChat: result.current }, true, 'codex')?.run()
}

it('forks a replying chat through its newest finished response', () => {
  const fork = paneFork(['reply-1', 'reply-2-streaming'])

  const notice = runForkWhileReplying(fork, { kind: 'ready', throughItemId: 'reply-1' })

  expect(notice).toBeNull()
  expect(fork.request).toHaveBeenCalledWith('reply-1')
  expect(fork.forkLatest).not.toHaveBeenCalled()
})

it('refuses without forking when the running reply is the only one', () => {
  const fork = paneFork(['reply-1-streaming'])

  const notice = runForkWhileReplying(fork, { kind: 'reply-running' })

  expect(notice).toEqual(expect.any(String))
  expect(fork.request).not.toHaveBeenCalled()
  expect(fork.forkLatest).not.toHaveBeenCalled()
})
