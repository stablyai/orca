// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useNativeChatHistoryJump, type HistoryJumpResult } from './use-native-chat-history-jump'
import { NATIVE_CHAT_RESTORE_MAX_PAGES } from './use-native-chat-reading-position'

it('a returning chat reads at most its restore budget of older pages, then gives up on the bookmark', async () => {
  let pagesRead = 0
  const jump = renderHook(() =>
    useNativeChatHistoryJump({
      step: () => 'page',
      sessionKey: 'session',
      isVisible: true,
      loadEarlier: async () => {
        pagesRead += 1
        return 'applied'
      }
    })
  )
  let result: HistoryJumpResult | null = null
  act(() =>
    jump.result.current.start(
      { kind: 'item', id: 'deep', offset: 0, maxPages: NATIVE_CHAT_RESTORE_MAX_PAGES },
      (settled) => (result = settled)
    )
  )
  // Each page waits for a commit, so the jump advances one act at a time.
  for (let tick = 0; tick < 50 && result === null; tick++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  expect(result).toBe('missing')
  expect(pagesRead).toBe(3)
})
