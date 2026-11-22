// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { NativeChatOlderPageResult } from '../history/native-chat-pagination'
import { useNativeChatHistoryJump } from './use-native-chat-history-jump'

// Perf contract (STA-15961): stepping to a find match in older history reads pages twice as wide
// as scrolling does, so reaching a message N messages back takes N/400 reads, not N/200.

async function readsToReach(depth: number): Promise<number[]> {
  const pages: number[] = []
  let loaded = 300
  const loadEarlier = async (pageSize = 200): Promise<NativeChatOlderPageResult> => {
    pages.push(pageSize)
    loaded += pageSize
    return 'applied'
  }
  let landed = false
  const { result } = renderHook(() =>
    useNativeChatHistoryJump({
      step: () => (loaded >= depth ? 'landed' : 'page'),
      sessionKey: 'claude:session-1',
      isVisible: true,
      loadEarlier
    })
  )
  act(() => {
    result.current.start({ kind: 'find', id: 'message-deep' }, (outcome) => {
      landed = outcome === 'landed'
    })
  })
  await waitFor(() => expect(landed).toBe(true))
  return pages
}

it('reaches a match N and 10N messages back in wide pages', async () => {
  const near = await readsToReach(2_300)
  const far = await readsToReach(20_300)
  expect({ near: near.length, far: far.length }).toEqual({ near: 5, far: 50 })
  expect(new Set([...near, ...far])).toEqual(new Set([400]))
})
