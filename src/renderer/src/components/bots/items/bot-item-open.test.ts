// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setRightSidebarTab: () => {}, setRightSidebarOpen: () => {} }) }
}))

import { openBotItem, useBotItemOpenRequest } from './bot-item-open'

afterEach(cleanup)

const A = { hostId: 'local', id: 'bot-a' } as const
const B = { hostId: 'local', id: 'bot-b' } as const

it('opens a chip’s item only in its own bot’s panel, once, across remounts', () => {
  const openInB = vi.fn()
  renderHook(() => useBotItemOpenRequest(B, openInB))
  act(() => openBotItem(A, 'item-of-a'))
  expect(openInB).not.toHaveBeenCalled()

  const openInA = vi.fn()
  const first = renderHook(() => useBotItemOpenRequest(A, openInA))
  expect(openInA).toHaveBeenCalledExactlyOnceWith('item-of-a')

  // Switching bots and back, or settings and back, remounts the panel: the ask is already taken.
  first.unmount()
  const again = vi.fn()
  renderHook(() => useBotItemOpenRequest(A, again))
  expect(again).not.toHaveBeenCalled()
})
